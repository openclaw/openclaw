import { readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { HarnessCompletionRecovery } from "../../../config/sessions/restart-recovery-types.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import * as sessionEntryWriter from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { createMemorySessionActorOwner } from "../../../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "../../../config/sessions/session-actor-storage-result.js";
import { preparePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import { SessionTranscriptWriterClaimReboundError } from "../../../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import {
  recoverOperatorApprovalsOnStartup,
  consumeOperatorApprovalAllowOnce,
  forceDenyOperatorApproval,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../../../gateway/operator-approval-store.js";
import { windowInitialMessages } from "../../../gateway/worker-environments/worker-turn-payload.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../../infra/agent-events.js";
import { registerAgentRunContext } from "../../../infra/agent-run-registry.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../../test-utils/native-sqlite.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
import { createHarnessCompletionSourceAssertion } from "../../agent-harness-completion-recovery.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { installSessionPlacementAdmissionProvider } from "../../session-placement-admission.js";
import { convertToLlm } from "../../sessions/messages.js";
import * as noteWriter from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../stream-message-shared.js";
import { log } from "../logger.js";
import {
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  testing as runsTesting,
} from "../runs.test-support.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createLaneControllerFixture } from "./lane-controller.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

const fixture = useTempSessionsFixture("lane-writer-claim-");
const sessionId = "writer-session";
const sessionKey = "agent:main:writer-session";
const lifecycleRevision = "writer-revision";
const sessionRevision = { lifecycleRevision, sessionId };
const completedResult: EmbeddedAgentRunResult = { meta: { durationMs: 0 } };

const writerScope = () => ({ agentId: "main", sessionKey, storePath: fixture.storePath() });
const readEntry = () => loadSessionEntry(writerScope());
const assistantMessage = (text: string) =>
  buildAssistantMessage({
    model: { api: "openai-responses", provider: "openai", id: "gpt-test" },
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: buildUsageWithNoCost({}),
  });

function writerParams(overrides: Partial<RunEmbeddedAgentParams> = {}) {
  return {
    ...writerScope(),
    prompt: "hello",
    runId: "run-b",
    sessionFile: sessionKey,
    sessionId,
    sessionTarget: { ...writerScope(), sessionId },
    timeoutMs: 30_000,
    workspaceDir: "/tmp",
    enqueue: async (task) => await task(),
    ...overrides,
  } satisfies RunEmbeddedAgentParams;
}

async function seedWriter(runId = "run-a", extra: Partial<InternalSessionEntry> = {}) {
  await replaceSessionEntry(writerScope(), {
    activeWriterRunId: runId,
    ...sessionRevision,
    updatedAt: 1,
    ...extra,
  } as InternalSessionEntry);
}

function installWriter(
  runId: string,
  cancel: Parameters<typeof setActiveEmbeddedRun>[1]["cancel"],
  stopped = false,
) {
  return setActiveEmbeddedRun(
    sessionId,
    {
      kind: "embedded",
      runId,
      cancel,
      abort: vi.fn(),
      isCompacting: () => false,
      ...(stopped ? { isStopped: () => true } : {}),
      isStreaming: () => !stopped,
      queueMessage: async () => {},
    },
    sessionKey,
    sessionKey,
  );
}

function observeLifecycle(runId: string) {
  const events: unknown[] = [];
  onTestFinished(
    onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        events.push(event);
      }
    }),
  );
  return events;
}

function captureStaleWriter(runId: string) {
  const fence = {
    ...writerScope(),
    expectedLifecycleRevision: lifecycleRevision,
    expectedWriterRunId: runId,
  };
  const manager = SessionManager.open({ ...fence, sessionId }, "/tmp");
  return async () => {
    expect(() => manager.appendMessage(assistantMessage("late model output"))).toThrow(
      SessionTranscriptWriterClaimReboundError,
    );
    expect(
      await appendExactAssistantMessageToSessionTranscript({
        ...fence,
        expectedSessionId: sessionId,
        message: assistantMessage("late output"),
      }),
    ).toMatchObject({ ok: false, code: "session-rebound" });
  };
}

function recoveryLane(runId: string, recovery = true) {
  setRuntimeConfigSnapshot({});
  onTestFinished(clearRuntimeConfigSnapshot);
  const prepared = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: recovery
        ? { kind: "recovery", boundary: "gateway.main-session-recovery", state: "present" }
        : { kind: "system", boundary: "fresh-request", state: "present" },
    },
  });
  const params: RunEmbeddedAgentParams & { sessionFile: string } = {
    agentId: "main",
    runId,
    sessionId,
    sessionKey,
    sessionFile: sessionKey,
    sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
    prompt: "Continue the interrupted request",
    timeoutMs: 30_000,
    workspaceDir: "/tmp",
    preparedRunAdmission: { ...prepared },
    enqueue: async (task) => await task(),
  };
  return {
    prepared,
    run: () => {
      const { controller } = createLaneControllerFixture(params, {
        configureRuntime: false,
        globalLane: `recovery-global:${runId}`,
      });
      return controller.enqueueSession(() => controller.enqueueGlobal(async () => completedResult));
    },
  };
}

describe("embedded run durable writer admission", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    runsTesting.resetActiveEmbeddedRuns();
  });

  afterEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
  });

  it("publishes recovery facts into model and worker context before placement", async () => {
    const text = "did not grant new permission or confirm";
    const target = { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
    await replaceSessionEntry(target, { sessionId, updatedAt: 1, lifecycleRevision });
    const user = makeUserMessage("Summarize the original notes", 1);
    SessionManager.open(target).appendMessage(user);
    const prior = SessionManager.open(target);
    prior.appendMessage({
      role: "custom",
      customType: "restart-recovery-admission",
      content: "A historical display-only recovery note.",
      display: true,
      excludeFromContext: true,
      timestamp: 2,
    });
    const originalEntries = prior.getEntries();
    const originalBytes = JSON.stringify(originalEntries);
    const original = prior.buildSessionContext().messages;
    const initial = convertToLlm(original);
    const workerInitial = windowInitialMessages(initial);
    const lane = recoveryLane("recovery-facts");
    const observed: string[] = [];
    const notifications: SessionTranscriptUpdate[] = [];
    const stopNotifications = onSessionTranscriptUpdate((event) => {
      if (event.sessionKey === sessionKey && event.message) {
        notifications.push(event);
      }
    });
    const stopPlacement = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: () => {},
      executeLocalTurn: async (_claim, run) => run(),
      executeTurn: async (_claim, _params, run) => {
        const reopened = await SessionManager.openAsync(target);
        const context = reopened.buildSessionContext().messages;
        const modelContext = convertToLlm(context);
        expect(modelContext).toHaveLength(initial.length + 1);
        expect(modelContext.slice(0, initial.length)).toEqual(initial);
        expect(modelContext.at(-1)).toMatchObject({
          role: "user",
          content: [{ type: "text", text: expect.stringContaining(text) }],
        });
        const workerContext = windowInitialMessages(modelContext);
        expect(workerContext.kind).toBe("complete");
        expect(workerInitial.kind).toBe("complete");
        if (workerContext.kind !== "complete" || workerInitial.kind !== "complete") {
          throw new Error("Recovery fixture lost its complete worker context");
        }
        expect(workerContext.messages.slice(0, -1)).toEqual(workerInitial.messages);
        expect(workerContext.messages.at(-1)).toMatchObject({
          role: "user",
          content: [{ type: "text", text: expect.stringContaining(text) }],
        });
        expect(JSON.stringify(reopened.getEntries().slice(0, originalEntries.length))).toBe(
          originalBytes,
        );
        const persisted = reopened
          .getEntries()
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        const note = persisted.findLast(
          (message) =>
            message.role === "custom" && message.customType === "restart-recovery-admission",
        );
        expect(note).toMatchObject({
          display: true,
          content: expect.stringContaining(text),
        });
        expect(persisted.filter((message) => message.role === "custom")).toHaveLength(2);
        observed.push("placement");
        return run();
      },
    });
    try {
      await lane.run();
      await lane.run();
      const fresh = recoveryLane("fresh-request", false);
      try {
        await fresh.run();
      } finally {
        fresh.prepared.close();
      }
      expect(observed).toEqual(["placement", "placement", "placement"]);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        runId: "recovery-facts",
        message: { role: "custom", customType: "restart-recovery-admission", display: true },
      });
    } finally {
      lane.prepared.close();
      stopPlacement();
      stopNotifications();
    }
  });

  it("carries exact cancelled proposals into recovery and later model context without inferring global absence", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.resolve(fixture.sessionsDir(), "../../.."));
    const target = { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
    const runId = "proposal-recovery";
    const sourceRunId = "interrupted-proposals";
    const now = Date.now();
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: now,
      lifecycleRevision,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: sourceRunId,
    });
    const source = { agentId: "main", sessionKey, sessionId, runId: sourceRunId };
    const overflowSource = { ...source, runId: "interrupted-approval-burst" };
    for (const [id, binding, operation] of [
      ["cancelled-add", source, "add"],
      ["cancelled-update", source, "update"],
      ["approved", source, "add"],
      ["approved-unconsumed", source, "add"],
      ["run-aborted", source, "add"],
      ["other-run", { ...source, runId: "another-run" }, "add"],
      [
        "other-session",
        { ...source, sessionKey: "agent:main:other", sessionId: "other-session" },
        "add",
      ],
      [
        "other-agent",
        {
          ...source,
          agentId: "other",
          sessionKey: "agent:other:main",
          sessionId: "other-agent-session",
        },
        "add",
      ],
      ["missing-session", { ...source, sessionId: null }, "add"],
      ["hidden-proposal", overflowSource, "add"],
      ...Array.from(
        { length: 8 },
        (_, index) => [`zz-ordinary-${index}`, overflowSource, undefined] as const,
      ),
    ] as const) {
      await insertOperatorApproval({
        approval: {
          id,
          kind: "exec",
          runtimeEpoch: "before-restart",
          source: binding,
          audienceSessionKeys: [sessionKey],
          createdAtMs: now,
          expiresAtMs: now + 60_000,
          presentation: {
            kind: "exec",
            commandText: "tail -F build.log",
            streamProposal: operation ? { jobId: `job-${id}`, name: id, operation } : undefined,
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      });
    }
    await resolveOperatorApproval({
      id: "approved",
      decision: "allow-once",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: now + 1,
    });
    await consumeOperatorApprovalAllowOnce({
      id: "approved",
      consumerId: "saved-proposal",
      nowMs: now + 2,
    });
    await resolveOperatorApproval({
      id: "approved-unconsumed",
      decision: "allow-once",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: now + 2,
    });
    await forceDenyOperatorApproval({
      id: "run-aborted",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "runtime", id: null },
      nowMs: now + 2,
    });
    // Use the real boot transition after all worker writes settle.
    await closeOpenClawStateDatabaseAsync();
    await recoverOperatorApprovalsOnStartup({ runtimeEpoch: "after-restart", nowMs: now + 3 });
    const mismatched = recoveryLane("different-recovery-claim");
    try {
      await mismatched.run();
      const context = (await SessionManager.openAsync(target)).buildSessionContext().messages;
      expect(JSON.stringify(convertToLlm(context))).not.toContain("cancelled-add");
    } finally {
      mismatched.prepared.close();
    }
    const lane = recoveryLane(runId);
    try {
      await lane.run();
      await lane.run();
      const context = convertToLlm(
        (await SessionManager.openAsync(target)).buildSessionContext().messages,
      );
      expect(context).toHaveLength(2);
      const text = JSON.stringify(context);
      expect(text).toContain("was canceled when the Gateway restarted");
      for (const sentence of [
        /Approval cancelled-add[^\n]*This proposal did not create or change a watcher\./,
        /Approval cancelled-update[^\n]*this proposal left the existing watcher unchanged\./,
      ]) {
        expect(context.at(-1)).toMatchObject({
          content: [{ type: "text", text: expect.stringMatching(sentence) }],
        });
      }
      expect(text).not.toMatch(
        /other-run|other-session|other-agent|missing-session|job-approved|run-aborted/,
      );
      expect(text).toContain("do not establish whether other watchers exist or are running");
      const fresh = recoveryLane("after-proposal-recovery", false);
      try {
        await fresh.run();
        expect(
          convertToLlm((await SessionManager.openAsync(target)).buildSessionContext().messages),
        ).toEqual(context);
      } finally {
        fresh.prepared.close();
      }
      await replaceSessionEntry(target, {
        sessionId,
        updatedAt: now,
        lifecycleRevision,
        restartRecoveryDeliveryRunId: "overflow-recovery",
        restartRecoveryDeliverySourceRunId: overflowSource.runId,
      });
      const overflow = recoveryLane("overflow-recovery");
      try {
        await overflow.run();
        const latest = convertToLlm(
          (await SessionManager.openAsync(target)).buildSessionContext().messages,
        ).at(-1);
        expect(JSON.stringify(latest)).not.toContain("hidden-proposal");
        expect(latest).toMatchObject({
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "Only part of the retained approval history was checked; unlisted proposal outcomes remain unknown.",
              ),
            },
          ],
        });
      } finally {
        overflow.prepared.close();
      }
    } finally {
      lane.prepared.close();
      await closeOpenClawStateDatabaseAsync();
      vi.unstubAllEnvs();
    }
  });

  it("rejects a recovery note when its prepared owner closes during the awaited append", async () => {
    const target = { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
    await replaceSessionEntry(target, { sessionId, updatedAt: 1, lifecycleRevision });
    const lane = recoveryLane("closing-recovery");
    const entered = createDeferred();
    const release = createDeferred();
    const append = noteWriter.appendSessionTranscriptNote;
    vi.spyOn(noteWriter, "appendSessionTranscriptNote").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return append(...args);
    });
    const pending = lane.run();
    const failure = expect(pending).rejects.toThrow(
      "prepared restart recovery is no longer active",
    );
    await entered.promise;
    lane.prepared.close();
    release.resolve();
    await failure;
    expect((await SessionManager.openAsync(target)).getEntries()).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a same-identity physical replacement while the recovery note is pending",
    async () => {
      const target = { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
      await replaceSessionEntry(target, { sessionId, updatedAt: 1, lifecycleRevision });
      const databasePath = await preparePhysicalSessionStorePath(target);
      const lane = recoveryLane("replaced-recovery");
      const entered = createDeferred();
      const release = createDeferred();
      const append = noteWriter.appendSessionTranscriptNote;
      vi.spyOn(noteWriter, "appendSessionTranscriptNote").mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        return append(...args);
      });
      const pending = lane.run();
      const failure = expect(pending).rejects.toThrow(/replaced|identity|source/i);
      const replacementPath = `${databasePath}.replacement`;
      const heldPath = `${databasePath}.held`;
      let replaced = false;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Recovery skipped the pending note");
          }),
        ]);
        const owner = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
        await backup(requireNativeSqliteDatabase(owner.db), replacementPath);
        expect(statSync(replacementPath, { bigint: true }).ino).not.toBe(
          statSync(databasePath, { bigint: true }).ino,
        );
        const replacementBytes = readFileSync(replacementPath);
        renameSync(databasePath, heldPath);
        renameSync(replacementPath, databasePath);
        replaced = true;
        release.resolve();
        await failure;
        expect(readFileSync(databasePath)).toEqual(replacementBytes);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        if (replaced) {
          renameSync(databasePath, replacementPath);
          renameSync(heldPath, databasePath);
        }
        lane.prepared.close();
      }
      expect((await SessionManager.openAsync(target)).getEntries()).toEqual([]);
    },
  );

  it("supersedes the live prior writer, claims the row, and rejects its late append", async () => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await seedWriter();

    const takeoverOrder: string[] = [];
    const readWriter = () => (readEntry() as InternalSessionEntry | undefined)?.activeWriterRunId;
    const cancelA = vi.fn(() => takeoverOrder.push(`cancel:${readWriter()}`));
    const operationA = installWriter("run-a", cancelA);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("run-a", {
      agentId: "main",
      lifecycleGeneration,
      sessionId,
      sessionKey,
    });
    const assertStaleWriter = captureStaleWriter("run-a");
    let supersededOutcome: AgentRunTerminalOutcome | undefined;
    onTestFinished(
      onAgentEvent((event) => {
        if (event.runId === "run-a" && event.stream === "lifecycle" && event.data.phase === "end") {
          takeoverOrder.push(`record:${readWriter()}`);
          supersededOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
            phase: "end",
            data: event.data,
            endedAt: event.data.endedAt,
          });
        }
      }),
    );

    await expect(
      claimAgentSessionWriter(writerParams({ lifecycleGeneration })),
    ).resolves.toMatchObject({
      expectedLifecycleRevision: lifecycleRevision,
      expectedWriterRunId: "run-b",
      entry: { activeWriterRunId: "run-b", ...sessionRevision },
    });

    // Supersede is a controller Stop source: the incumbent turn records it as its outcome.
    expect(operationA.result).toEqual({ kind: "aborted", code: "aborted_for_supersession" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("live=true"));
    expect(takeoverOrder).toEqual(["record:run-b", "cancel:run-b"]);
    expect(supersededOutcome).toMatchObject({
      reason: "superseded",
      status: "error",
      stopReason: "superseded",
    });
    expect(readEntry()).toMatchObject({
      activeWriterRunId: "run-b",
      ...sessionRevision,
      updatedAt: 1,
    });
    await assertStaleWriter();
  });

  it.each([false, true])(
    "revalidates terminal writer cleanup at the worker grant (retired=%s)",
    async (retired) => {
      const scope = { agentId: "main", sessionKey, storePath: fixture.storePath() };
      await replaceSessionEntry(scope, {
        lifecycleRevision,
        sessionId,
        updatedAt: 1,
      } as InternalSessionEntry);
      const claim = await claimAgentSessionWriter({
        ...scope,
        prompt: "terminal turn",
        runId: "terminal-writer",
        sessionId,
        sessionTarget: { ...scope, sessionId },
        timeoutMs: 30_000,
        workspaceDir: "/tmp",
      });
      expect(claim).toBeDefined();

      let current = true;
      probe.admission(workerAdmission, (request, grant, callback) => {
        if (retired) {
          current = false;
        }
        callback(request, grant);
      });
      await expect(claim?.revoke(() => current)).resolves.toBe(!retired);
      expect(loadSessionEntry(scope)?.activeWriterRunId).toBe(
        retired ? "terminal-writer" : undefined,
      );
      const lateAppend = await appendExactAssistantMessageToSessionTranscript({
        ...scope,
        expectedLifecycleRevision: lifecycleRevision,
        expectedSessionId: sessionId,
        expectedWriterRunId: "terminal-writer",
        message: buildAssistantMessage({
          model: { api: "openai-responses", provider: "openai", id: "gpt-test" },
          content: [{ type: "text", text: "late terminal output" }],
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        }),
      });
      expect(lateAppend).toMatchObject(
        retired ? { ok: true } : { ok: false, code: "session-rebound" },
      );
    },
  );

  it.each([false, true])(
    "revokes cancelled memory writer custody without clearing a successor (successor=%s)",
    async (successor) => {
      const key = "agent:main:dashboard:incognito-terminal-writer";
      const scope = { agentId: "main", sessionKey: key, storePath: "/synthetic/terminal-writer" };
      const owner = createMemorySessionActorOwner({
        agentId: scope.agentId,
        path: scope.storePath,
      });
      const hostAuthority = { assertCurrent() {}, authorize() {} };
      let cancelled = false;
      const assertExecutionCurrent = () => {
        if (cancelled) {
          throw new Error("Memory execution is cancelled");
        }
      };
      const actor = await owner.acquire(
        { database: owner.identity, sessionKey: key },
        { assertCurrent: assertExecutionCurrent, assertReadable: assertExecutionCurrent },
      );
      const target = captureSessionTarget({
        storeScope: scope.storePath,
        sessionKey: key,
        agentId: scope.agentId,
        incarnation: sessionId,
      });
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId,
        agentId: scope.agentId,
        resetTriggered: false,
        target,
      });
      let replacementOperation: ReturnType<typeof createReplyOperation> | undefined;
      try {
        readSessionActorStorageResult(
          await actor.storage!.mutate(
            {
              type: "session.entry.create",
              input: { entry: { sessionId, lifecycleRevision, updatedAt: 1, incognito: true } },
            },
            hostAuthority,
          ),
        );
        await runWithSessionActorStorage(
          {
            actor,
            agentId: scope.agentId,
            path: scope.storePath,
            authority: { assertCurrent: assertExecutionCurrent, authorize: assertExecutionCurrent },
          },
          async () => {
            const claim = await claimAgentSessionWriter({
              ...scope,
              prompt: "terminal memory turn",
              runId: "terminal-memory-writer",
              sessionId,
              sessionTarget: { ...scope, sessionId },
              replyOperation: operation,
              timeoutMs: 30_000,
              workspaceDir: "/tmp",
            });
            expect(claim).toBeDefined();
            cancelled = true;
            operation.abort("stop");
            if (successor) {
              operation.complete();
              replacementOperation = createReplyOperation({
                sessionKey: key,
                sessionId,
                agentId: scope.agentId,
                resetTriggered: false,
                target,
              });
              const replacement = await owner.acquireExisting(key, {
                assertCurrent() {},
                assertReadable() {},
              });
              try {
                readSessionActorStorageResult(
                  await replacement!.storage!.mutate(
                    {
                      type: "session.entry.patch",
                      input: {
                        operation: { kind: "fields", patch: { activeWriterRunId: "next-writer" } },
                      },
                    },
                    hostAuthority,
                  ),
                );
              } finally {
                await replacement?.release();
              }
            }

            await expect(claim?.revoke(() => true)).resolves.toBe(!successor);
            expect(owner.readSession(key, hostAuthority)?.entry?.activeWriterRunId).toBe(
              successor ? "next-writer" : undefined,
            );
          },
        );
      } finally {
        replacementOperation?.complete();
        operation.complete();
        await actor.release();
        owner.close();
      }
    },
  );

  it("silently replaces a persisted claim whose prior run is no longer live", async () => {
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }, {
      activeWriterRunId: "completed-run",
      lifecycleRevision,
      sessionId,
      updatedAt: 1,
    } as InternalSessionEntry);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    // Cold admission registers its native lease; observe the warmed claim mutation separately.
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }),
    ).toMatchObject({ activeWriterRunId: "completed-run" });
    const sql = observeHostDataSql();
    try {
      await claimAgentSessionWriter({
        agentId: "main",
        prompt: "next turn",
        runId: "run-next",
        sessionId,
        sessionKey,
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
        timeoutMs: 30_000,
        workspaceDir: "/tmp",
      });
      expect(
        sql.queries.filter((query) =>
          /session_nodes|session_entry_snapshots|session_participants|session_windows|\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/i.test(
            query,
          ),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }

    expect(warn).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() }),
    ).toMatchObject({ activeWriterRunId: "run-next" });
  });

  it("silently replaces a stopped prior writer while keeping stale transcript writes fenced", async () => {
    await seedWriter("run-stopped");
    const cancel = vi.fn();
    installWriter("run-stopped", cancel, true);
    const events = observeLifecycle("run-stopped");
    const assertStaleWriter = captureStaleWriter("run-stopped");

    await claimAgentSessionWriter(writerParams({ prompt: "next turn", runId: "run-next" }));

    expect(cancel).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(readEntry()).toMatchObject({ activeWriterRunId: "run-next", updatedAt: 1 });
    await assertStaleWriter();
  });

  it.each([false, true])(
    "keeps recovery-source SQL outside worker grants and checks the prepared read (revoked=%s)",
    async (revoke) => {
      const claim: HarnessCompletionRecovery = {
        taskId: "completion-task",
        taskRunId: "completion-task-run",
        taskStatus: "succeeded",
        sourceRunId: "announce:completion",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        ...sessionRevision,
      };
      await seedWriter("run-a", {
        restartRecoveryHarnessCompletion: claim,
        restartRecoveryDeliveryRunId: claim.sourceRunId,
      });
      let sourceCurrent = true;
      const revoked = new Error("recovery source retired during preparation");
      const assertSourceCurrent = createHarnessCompletionSourceAssertion({
        claim,
        storePath: fixture.storePath(),
        priorAssertion() {
          if (!sourceCurrent) {
            throw revoked;
          }
        },
      });
      const prepared = prepareSystemAgentRunAdmission(
        {},
        "run-b",
        "main",
        "writer-test",
        assertSourceCurrent,
      );
      const admittedRunContext = await prepared.admit("embedded");
      const sameStoreQueriesInGrants: string[] = [];
      probe.admission(workerAdmission, (request, grant, callback) => {
        const sql = observeHostDataSql();
        try {
          callback(request, grant);
        } finally {
          sameStoreQueriesInGrants.push(
            ...sql.queries.filter((query) =>
              /\bsession_(?:nodes|windows|participants)\b/.test(query),
            ),
          );
          sql.restore();
        }
        if (revoke) {
          sourceCurrent = false;
        }
      });
      try {
        const claiming = claimAgentSessionWriter(writerParams({ admittedRunContext }));
        if (revoke) {
          await expect(claiming).rejects.toMatchObject({
            message: "admitted run authority is no longer active",
            cause: revoked,
          });
        } else {
          await claiming;
        }
        expect(readEntry()).toMatchObject({
          activeWriterRunId: revoke ? "run-a" : "run-b",
        });
        expect(sameStoreQueriesInGrants).toEqual([]);
      } finally {
        prepared.close();
      }
    },
  );

  it("leaves the incumbent live when the replacement claim does not commit", async () => {
    await seedWriter();
    const cancelA = vi.fn();
    installWriter("run-a", cancelA);
    const events = observeLifecycle("run-a");
    vi.spyOn(sessionEntryWriter, "applySessionEntryOperation").mockRejectedValueOnce(
      new Error("replacement claim conflict"),
    );
    await expect(claimAgentSessionWriter(writerParams())).rejects.toThrow(
      "replacement claim conflict",
    );

    expect(cancelA).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(readEntry()).toMatchObject({ activeWriterRunId: "run-a" });
  });
});
