import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import * as sessionEntryWriter from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { createMemorySessionActorOwner } from "../../../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "../../../config/sessions/session-actor-storage-result.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import { SessionTranscriptWriterClaimReboundError } from "../../../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
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
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../stream-message-shared.js";
import { log } from "../logger.js";
import {
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  testing as runsTesting,
} from "../runs.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

const fixture = useTempSessionsFixture("lane-writer-claim-");
const sessionId = "writer-session";
const sessionKey = "agent:main:writer-session";
const lifecycleRevision = "writer-revision";
const sessionRevision = { lifecycleRevision, sessionId };

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
    "keeps source SQL outside worker grants and checks live authority (revoked=%s)",
    async (revoke) => {
      await seedWriter("run-a");
      let sourceCurrent = true;
      const revoked = new Error("source retired during preparation");
      const assertSourceCurrent = () => {
        if (!sourceCurrent) {
          throw revoked;
        }
      };
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
