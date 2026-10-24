import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertMessages } from "../../../packages/ai/src/openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "../../../packages/ai/src/transports/openai-completions-compat.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputReceipts,
  loadSessionEntry,
  loadTranscriptEvents,
  readActiveTranscriptEntryAnchor,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readClosedTranscriptTurnInDatabase } from "../../config/sessions/session-accessor.transcript-range.worker.js";
import * as sessionMessageRewrite from "../../config/sessions/session-message-rewrite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "../../gateway/worker-environments/placement-test-fixtures.js";
import { readCodexSessionTranscriptEventsBeforeAdmission } from "../../plugin-sdk/codex-session-transcript-runtime.js";
import { readSessionTranscriptVisibleMessageDelta } from "../../plugin-sdk/session-transcript-runtime.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  UserTurnTranscriptAnnotation,
} from "../../sessions/user-turn-transcript.types.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { convertToLlm } from "../sessions/messages.js";
import { completionModel } from "../simple-completion.test-support.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
} from "./context-engine-turn-attempt.js";
import { createTurnLease } from "./context-engine-turn.test-support.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

afterEach(() => vi.restoreAllMocks());

function nativeAnnotation(
  content = "prompt",
  upstreamUserText = "native prompt",
): UserTurnTranscriptAnnotation {
  return {
    mirrorIdentity: "native-turn:prompt",
    mirrorOrigin: "codex-app-server",
    upstreamUserText,
    mirrorSourceFingerprint: createHash("sha256")
      .update(
        JSON.stringify({ role: "user", content, upstreamUserText: upstreamUserText || undefined }),
      )
      .digest("hex")
      .slice(0, 32),
  };
}

function annotationCapability(host: ReturnType<typeof createAgentHarnessHostCapabilities>) {
  return expectDefined(host.capabilities.annotateCurrentUserTurn, "annotation capability");
}

async function withAdmission(
  run: (fixture: Awaited<ReturnType<typeof prepareAdmission>>) => Promise<void>,
  options: Partial<Pick<CreateUserTurnTranscriptRecorderParams, "input" | "beforeMessageWrite">> & {
    config?: OpenClawConfig;
    persist?: boolean;
    cronBaseKey?: string;
  } = {},
) {
  await withOpenClawTestState({ label: "admission-annotation" }, async (state) => {
    setRuntimeConfigSnapshot(options.config ?? {}, options.config);
    const fixture = await prepareAdmission(
      path.join(state.sessionsDir(), "sessions.json"),
      options,
    );
    try {
      await run(fixture);
    } finally {
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });
}

async function prepareAdmission(
  storePath: string,
  options: Parameters<typeof withAdmission>[1] = {},
) {
  const runId = randomUUID();
  const target = {
    agentId: "main",
    sessionId: "admitted",
    sessionKey: options.cronBaseKey ? `${options.cronBaseKey}:run:admitted` : "agent:main:admitted",
    storePath,
    expectedLifecycleRevision: "initial",
    expectedWriterRunId: runId,
  };
  const entry = { sessionId: target.sessionId, updatedAt: 1, lifecycleRevision: "initial" };
  if (options.cronBaseKey) {
    await upsertSessionEntryCore({ ...target, sessionKey: options.cronBaseKey }, entry);
  }
  await upsertSessionEntryCore(target, { ...entry, activeWriterRunId: runId });
  const patchSession = (patch: Record<string, unknown>) =>
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, target.sessionKey, {
          ...expectDefined(loadSessionEntry(target), "session"),
          ...patch,
        });
      },
      { agentId: target.agentId },
    );
  const prior = expectDefined(
    await appendTranscriptMessage(target, {
      message: { role: "user", content: "prior", timestamp: 1 },
    }),
    "prior",
  );
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: "prompt",
      timestamp: 123,
      idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
      senderIsOwner: true,
      sender: { id: "sender" },
      ...options.input,
    },
    target: { ...target, sessionEntry: loadSessionEntry(target), config: options.config },
    beforeMessageWrite: options.beforeMessageWrite,
  });
  if (options.persist !== false) {
    await recorder.persistApproved();
  }
  const controller = new AbortController();
  const attempt = {
    ...target,
    sessionTarget: target,
    runId,
    config: options.config ?? {},
    userTurnTranscriptRecorder: recorder,
    abortSignal: controller.signal,
  };
  const host = await createAdmittedHostCapabilityTestFixture(attempt);
  const createHost = (
    overrides: Partial<Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"]> = {},
  ) =>
    createAgentHarnessHostCapabilities({
      attempt: { ...attempt, admittedRunContext: host.admittedRunContext, ...overrides },
      pluginId: "codex",
    });
  const annotate = (annotation = nativeAnnotation()) =>
    expectDefined(
      host.hostCapabilities.annotateCurrentUserTurn,
      "annotation capability",
    )(annotation);
  return {
    ...host,
    attempt,
    target,
    prior,
    recorder,
    controller,
    createHost,
    patchSession,
    annotate,
    async expectRefused(annotation = nativeAnnotation(), message?: string) {
      const before = await loadTranscriptEvents(target);
      await expect(annotate(annotation)).rejects.toThrow(message);
      expect(await loadTranscriptEvents(target)).toEqual(before);
    },
    receipt: () => expectDefined(recorder.getAdmissionReceipt(), "admission"),
    async withHost(
      overrides: Parameters<typeof createHost>[0],
      run: (host: ReturnType<typeof createHost>) => Promise<void>,
    ) {
      const other = createHost(overrides);
      try {
        await run(other);
      } finally {
        other.close();
      }
    },
  };
}

async function holdTranscriptWriter(target: Parameters<typeof resolveSqliteTranscriptScope>[0]) {
  const entered = createDeferred();
  const release = createDeferred();
  const locked = runExclusiveSqliteSessionWrite(
    resolveSqliteTranscriptScope(target),
    async () => {
      entered.resolve();
      await release.promise;
    },
    "session.transcript.batch",
  );
  await entered.promise;
  return async () => {
    release.resolve();
    await locked;
  };
}

describe("host-owned current admission annotation", () => {
  it("annotates the exact cron run while its same-ID base row changes", async () => {
    const cronBaseKey = "agent:main:cron:annotation";
    await withAdmission(
      async (f) => {
        const before = await loadTranscriptEvents(f.target);
        const writer = loadSessionEntry(f.target);
        const base = { ...f.target, sessionKey: cronBaseKey };
        expect(loadSessionEntry(base)?.activeWriterRunId).toBeUndefined();
        const entered = createDeferred();
        const release = createDeferred();
        const rewrite = sessionMessageRewrite.rewritePreparedTranscriptMessageAtAnchor;
        const rewriteCall = vi
          .spyOn(sessionMessageRewrite, "rewritePreparedTranscriptMessageAtAnchor")
          .mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return rewrite(...args);
          });
        const pending = f.annotate();
        try {
          // Publish only after the real selector captured authority, before the real SQLite rewrite.
          await Promise.race([entered.promise, pending]);
          expect(rewriteCall).toHaveBeenCalledOnce();
          await upsertSessionEntryCore(base, {
            sessionId: f.target.sessionId,
            updatedAt: 2,
            lifecycleRevision: "base-successor",
          });
          release.resolve();
          await pending;
          expect(f.recorder.getPersistedMessage?.()).toMatchObject({
            content: "prompt",
            __openclaw: { ...nativeAnnotation(), runId: f.attempt.runId },
          });
          const after = await loadTranscriptEvents(f.target);
          expect(after).toHaveLength(before.length);
          expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
          expect(loadSessionEntry(f.target)).toMatchObject({
            lifecycleRevision: writer?.lifecycleRevision,
            activeWriterRunId: f.attempt.runId,
          });
        } finally {
          release.resolve();
          await pending.catch(() => {});
        }
      },
      { cronBaseKey },
    );
  });

  it("refreshes only the admitted collected input while preserving source custody", async () => {
    await withAdmission(
      async (f) => {
        expect(f.hostCapabilities.annotateCurrentUserTurn).toBeUndefined();
        await f.recorder.stageApproved?.({
          runId: f.attempt.runId,
          assertCurrent: f.hostCapabilities.assertActive,
        });
        const source = structuredClone(f.recorder.getPendingInputMessage?.());
        try {
          const before = await loadTranscriptEvents(f.target);
          const recorder = createUserTurnTranscriptRecorder({
            target: { ...f.target, sessionEntry: loadSessionEntry(f.target) },
            input: { text: "prompt", idempotencyKey: "collected:user", timestamp: 125 },
            pendingInputSources: [f.recorder],
          });
          await recorder.persistApproved();
          const consumptions = await listSessionPendingInputReceipts(f.target, {
            runIds: [f.attempt.runId],
          });
          await f.withHost({ userTurnTranscriptRecorder: recorder }, async (host) => {
            await annotationCapability(host)(nativeAnnotation());
            expect(recorder.getPersistedMessage?.()).toMatchObject({
              content: "prompt",
              __openclaw: nativeAnnotation(),
            });
            const after = await loadTranscriptEvents(f.target);
            expect(after).toHaveLength(before.length + 1);
            expect(after.slice(0, -1)).toEqual(before);
            expect(f.recorder.getPendingInputMessage?.()).toEqual(source);
            expect(
              await listSessionPendingInputReceipts(f.target, {
                runIds: [f.attempt.runId],
              }),
            ).toEqual(consumptions);
          });
        } finally {
          f.recorder.finishPendingInput?.("interrupted");
        }
      },
      { persist: false },
    );
  });

  it("refuses retargeting a refreshed recorder through its returned receipt and message", async () => {
    await withAdmission(async (f) => {
      await f.annotate();
      const other = expectDefined(
        readActiveTranscriptEntryAnchor({ ...f.target, entryId: f.prior.messageId }),
        "other active row",
      );
      const receipt = f.receipt();
      const logicalTurnId = receipt.logicalTurnId;
      for (const key of Object.keys(receipt)) {
        Reflect.deleteProperty(receipt, key);
      }
      Object.assign(receipt, other, { logicalTurnId, role: "user" });
      const exposed = expectDefined(f.recorder.getPersistedMessage?.(), "exposed message");
      for (const key of Object.keys(exposed)) {
        Reflect.deleteProperty(exposed, key);
      }
      Object.assign(exposed, f.prior.message);
      await f.expectRefused(nativeAnnotation("prior"));
    });
  });

  it("refreshes the same event once, resets cursors and advances the actual durable context-engine outbox", async () => {
    const provenance = { kind: "inter_session" as const, sourceTool: "heartbeat" };
    await withAdmission(
      async (f) => {
        const original = structuredClone(f.receipt());
        const before = await loadTranscriptEvents(f.target);
        const originalMessage = structuredClone(
          expectDefined(f.recorder.getPersistedMessage?.(), "persisted message"),
        );
        const page = await readSessionTranscriptVisibleMessageDelta(f.target);
        expect(page.kind).toBe("page");
        if (page.kind !== "page") {
          throw new Error("missing initial cursor");
        }
        const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
          status: "committed",
        }));
        const engine: ContextEngine = {
          info: {
            id: "annotation",
            name: "Annotation",
            transcriptSemantics: {
              currentTurnFence: "before-current-turn-entry-v1",
              turnAdvancementIdempotency: "atomic-idempotent-v1",
            },
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
          compact: async () => ({ ok: true, compacted: false }),
          commitTurn,
        };
        const lease: ContextEngineLogicalTurnLease = {
          ...createTurnLease(engine),
          effectiveEngineId: "annotation",
          dispose: async () => {},
        };
        const warn = vi.fn();
        await drainPendingContextEngineTurnsBeforeRun({
          admission: original,
          recorder: f.recorder,
          lease,
          warn,
        });
        const updates = vi.fn();
        const unsubscribe = onInternalSessionTranscriptUpdate(updates);
        try {
          const { db } = openOpenClawAgentDatabase({ agentId: "main" });
          await f.annotate();
          const refreshed = f.receipt();
          expect(refreshed).toEqual({ ...original, generation: expect.any(String) });
          expect(refreshed.generation).not.toBe(original.generation);
          expect(
            await readSessionTranscriptVisibleMessageDelta({ ...f.target, cursor: page.cursor }),
          ).toMatchObject({ kind: "reset" });
          expect(
            await readCodexSessionTranscriptEventsBeforeAdmission(f.target, refreshed),
          ).toEqual(before.slice(0, -1));
          expect(
            readClosedTranscriptTurnInDatabase(db, {
              boundary: { admission: original, terminal: refreshed },
              maxEvents: 20,
              maxBytes: 10000,
            }),
          ).toMatchObject({ kind: "session-rebound" });
          const after = await loadTranscriptEvents(f.target);
          expect(f.recorder.getPersistedMessage?.()).toMatchObject({
            content: "prompt",
            provenance,
            __openclaw: {
              mirrorIdentity: "native-turn:prompt",
              upstreamUserText: "native prompt",
            },
          });
          const model = completionModel({
            api: "openai-completions",
            provider: "openai",
            id: "gpt-5.5",
            baseUrl: "https://api.openai.com/v1",
          });
          const modelBytes = (message: typeof originalMessage) =>
            JSON.stringify(
              convertMessages(
                model,
                {
                  messages: convertToLlm(
                    normalizeMessagesForLlmBoundary([message], { timezone: "UTC" }),
                  ),
                },
                resolveOpenAICompletionsCompat(model),
              ),
            );
          expect(
            modelBytes(expectDefined(f.recorder.getPersistedMessage?.(), "annotated message")),
          ).toBe(modelBytes(originalMessage));
          await f.annotate();
          expect(await loadTranscriptEvents(f.target)).toEqual(after);
          expect(f.receipt()).toEqual(refreshed);
          expect(updates).toHaveBeenCalledOnce();
          expect(updates).toHaveBeenCalledWith(
            expect.objectContaining({
              messageId: original.entryId,
              messageSeq: original.activeMessagePosition + 1,
            }),
          );
          const terminal = expectDefined(
            await appendTranscriptMessage(f.target, {
              message: { role: "assistant", content: "answer", timestamp: 456 },
            }),
            "terminal",
          );
          const facts = {
            boundary: {
              admission: refreshed,
              terminal: expectDefined(terminal.anchor, "terminal anchor"),
            },
            sessionIdUsed: f.target.sessionId,
            sessionKey: f.target.sessionKey,
            sessionTarget: f.target,
            sessionFile: f.target.sessionKey,
            promptError: false,
            aborted: false,
            yieldAborted: false,
          };
          await finalizeAcceptedContextEngineTurn({ facts, lease, warn });
          expect(warn).not.toHaveBeenCalled();
          expect(commitTurn).toHaveBeenCalledOnce();
          expect(commitTurn).toHaveBeenCalledWith(
            expect.objectContaining({
              messages: [f.recorder.getPersistedMessage?.(), terminal.message],
            }),
          );
        } finally {
          unsubscribe();
        }
      },
      {
        input: { provenance },
        config: { logging: { redactPatterns: ["native prompt"] } },
      },
    );
  });

  it.each(["expectedLifecycleRevision", "expectedWriterRunId"] as const)(
    "does not replace an inherited %s with a fresh session snapshot",
    async (field) => {
      await withAdmission(async (f) => {
        await f.withHost({ sessionTarget: { ...f.target, [field]: "stale" } }, async (host) => {
          const before = await loadTranscriptEvents(f.target);
          await expect(annotationCapability(host)(nativeAnnotation())).rejects.toThrow();
          expect(await loadTranscriptEvents(f.target)).toEqual(before);
        });
      });
    },
  );

  it("does not transfer a retained operation to a replaced recorder or session target", async () => {
    await withAdmission(async (f) => {
      const attempt = { ...f.attempt, admittedRunContext: f.admittedRunContext };
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const annotate = annotationCapability(host);
      const before = await loadTranscriptEvents(f.target);
      try {
        attempt.userTurnTranscriptRecorder = { ...f.recorder };
        await expect(annotate(nativeAnnotation())).rejects.toThrow();
        attempt.userTurnTranscriptRecorder = f.recorder;
        attempt.sessionTarget = { ...f.target, sessionId: "successor" };
        await expect(annotate(nativeAnnotation())).rejects.toThrow();
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
      } finally {
        host.close();
      }
    });
  });

  it.each([
    "host-close",
    "admission-close",
    "abort",
    "writer",
    "session",
    "replacement",
    "blocked",
  ] as const)("refuses a queued write after %s revocation", async (reason) => {
    await withAdmission(async (f) => {
      const before = await loadTranscriptEvents(f.target);
      const release = await holdTranscriptWriter(f.target);
      const updates = vi.fn();
      const unsubscribe = onInternalSessionTranscriptUpdate(updates);
      const pending = f.annotate();
      const refused = expect(pending).rejects.toThrow();
      try {
        await {
          "host-close": f.closeHost,
          "admission-close": f.closeAdmission,
          abort: () => f.controller.abort(),
          writer: () => f.patchSession({ activeWriterRunId: "successor" }),
          session: () => f.patchSession({ sessionId: "successor" }),
          blocked: () => f.recorder.markBlocked(),
          replacement: async () => {
            const replacement = await createAdmittedHostCapabilityTestFixture(f.attempt);
            replacement.closeHost();
            replacement.closeAdmission();
          },
        }[reason]();
      } finally {
        await release();
      }
      try {
        await refused;
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
        expect(updates).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });
  });

  it("revalidates the captured host-owned worker claim inside the write transaction", async () => {
    await withAdmission(async (f) => {
      const placements = createWorkerSessionPlacementStore();
      await advancePlacementFixtureToActive(placements, openOpenClawStateDatabase(), f.target, {
        environmentId: "annotation-worker",
        remoteWorkspaceDir: "/workspace/annotation",
        seedEnvironment: "before-dispatch",
      });
      const claim = await placements.claimTurn({
        ...f.target,
        runId: f.attempt.runId,
        claimId: "current-claim",
        owner: { kind: "worker", environmentId: "annotation-worker", ownerEpoch: 7 },
      });
      const host = await withGatewayToolCallerIdentity(
        {
          agentId: f.target.agentId,
          sessionKey: f.target.sessionKey,
          operationalRunInstance: f.admittedRunContext.operationalRunInstance,
          workerTurnClaim: claim,
          receiptAuthority: () => placements.validateTurnClaim(claim),
        },
        () => f.createHost(),
      );
      const before = await loadTranscriptEvents(f.target);
      const release = await holdTranscriptWriter(f.target);
      const refused = expect(annotationCapability(host)(nativeAnnotation())).rejects.toThrow(
        "claim",
      );
      await placements.releaseTurn(claim);
      await release();
      try {
        await refused;
        expect(() => host.capabilities.assertActive()).toThrow("claim");
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
      } finally {
        host.close();
      }
    });
  });

  it("does not annotate after an external edit", async () => {
    await withAdmission(async (f) => {
      const events = await loadTranscriptEvents(f.target);
      const event = expectDefined(asOptionalRecord(events.at(-1)), "transcript event");
      event.message = { ...f.recorder.getPersistedMessage?.(), content: "edited" };
      await replaceTranscriptEvents(f.target, events);
      await f.expectRefused();
    });
  });

  it("refuses conflicting native provenance without rewriting again", async () => {
    await withAdmission(async (f) => {
      await f.annotate();
      await f.expectRefused({ ...nativeAnnotation(), mirrorOrigin: "other-harness" });
    });
  });

  it("refuses a native annotation recorded for another run", async () => {
    await withAdmission(
      async (f) => {
        await f.expectRefused(undefined, "recorded provenance");
      },
      {
        beforeMessageWrite: ({ message }) => ({
          ...message,
          __openclaw: {
            ...asOptionalRecord(Reflect.get(message, "__openclaw")),
            ...nativeAnnotation(),
            runId: "another-run",
          },
        }),
      },
    );
  });

  it("does not rerun admission hooks or bless their content edits", async () => {
    const hook = vi.fn<NonNullable<CreateUserTurnTranscriptRecorderParams["beforeMessageWrite"]>>(
      ({ message }) => ({ ...message, content: "hook changed" }),
    );
    await withAdmission(
      async (f) => {
        await f.expectRefused(undefined, "admitted content");
        expect(hook).toHaveBeenCalledOnce();
      },
      { beforeMessageWrite: hook },
    );
  });

  it("does not issue current-row authority for a copied recorder", async () => {
    await withAdmission(async (f) => {
      await f.withHost({ userTurnTranscriptRecorder: { ...f.recorder } }, async (host) => {
        expect(host.capabilities.annotateCurrentUserTurn).toBeUndefined();
      });
    });
  });

  it("does not issue current-row authority for an excluded recorder", async () => {
    await withAdmission(
      async (f) => {
        expect(f.hostCapabilities.annotateCurrentUserTurn).toBeUndefined();
      },
      { input: { display: false, excludeFromContext: true, text: "prompt" } },
    );
  });

  it("revokes annotation when steering is confirmed without waiting on its own runtime promise", async () => {
    await withAdmission(async (f) => {
      await f.recorder.confirmSteerTargetRunIdForPersistence?.("steered-run");
      const before = await loadTranscriptEvents(f.target);
      const pending = f.annotate();
      f.recorder.markRuntimePersistencePending(pending);
      await expect(pending).rejects.toThrow();
      expect(await loadTranscriptEvents(f.target)).toEqual(before);
    });
  });
});
