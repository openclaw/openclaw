import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyBackendQueueMessageResult,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as events from "../../config/sessions/session-accessor.sqlite-events.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { rewriteTranscriptMessageAtAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-message-rewrite.js";
import { appendTranscriptMessageSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "../../config/sessions/session-transcript-read-fence.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import * as steeringStore from "../../sessions/user-turn-transcript-steering-store.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import {
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let count = 0;
beforeAll(() => vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-steering-binding-")));
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function fixture() {
  const sessionId = "steering-binding-" + ++count;
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:" + sessionId,
    storePath: database.path,
  };
  const runId = sessionId + "-run";
  const entry = {
    sessionId,
    updatedAt: 1,
    lifecycleRevision: "lifecycle",
    activeWriterRunId: runId,
  };
  replaceSessionEntrySync(scope, entry);
  const append = (id: string) => {
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: id, timestamp: 1, idempotencyKey: sessionId + ":" + id },
      target: { ...scope, sessionEntry: undefined },
    });
    const result = appendTranscriptMessageSync(scope, { eventId: id, message: recorder.message! });
    if (!result.ok || !result.value) {
      throw new Error("fixture append refused");
    }
    const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: id });
    if (!anchor) {
      throw new Error("fixture anchor absent");
    }
    recorder.markRuntimePersisted(result.value.message, anchor);
    return recorder;
  };
  const A = append("A");
  const B = append("B");
  const target = {
    ...scope,
    expectedLifecycleRevision: entry.lifecycleRevision,
    expectedWriterRunId: runId,
  };
  const fence = (recorder: UserTurnTranscriptRecorder) =>
    runWithSessionTranscriptReadFence(recorder.getAdmissionReceipt(), () =>
      resolveSqliteSessionTranscriptReadFence({ database, ...scope }),
    );
  const attempt = {
    ...scope,
    sessionFile: scope.sessionKey,
    runId,
    sessionTarget: target,
    userTurnTranscriptRecorder: A,
    config: {},
    workspaceDir: tempDirs.make("openclaw-steering-workspace-"),
    provider: "openai",
    modelId: "gpt-test",
    senderIsOwner: true,
  };
  return { A, B, append, scope, target, entry, runId, fence, attempt };
}

async function runBound(
  f: ReturnType<typeof fixture>,
  run: (owner: {
    handle: ReturnType<typeof createEmbeddedRunHandle>;
    close: () => void;
    abort: () => void;
    revokeSource: () => void;
    operation?: ReturnType<typeof createReplyOperation>;
    inject: (
      recorder?: UserTurnTranscriptRecorder,
      options?: ReplyBackendQueueMessageOptions & { assertCurrent?: () => void },
    ) => ReturnType<typeof beginReplyMessageInjectionTarget>;
  }) => Promise<void>,
  options: {
    reply?: boolean;
    noContinuation?: boolean;
    queue?: (
      options?: ReplyBackendQueueMessageOptions,
    ) => Promise<void | ReplyBackendQueueMessageResult>;
  } = {},
) {
  const preparedAdmission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(f.runId),
    facts: {
      agentId: "main",
      runId: f.runId,
      ingress: { kind: "system", state: "present", boundary: "steering-test" },
    },
  });
  const admittedRunContext = await preparedAdmission.admit("embedded", "steering-test");
  const operation = options.reply
    ? createReplyOperation({ ...f.scope, resetTriggered: false })
    : undefined;
  operation?.bindToolAuthoritySnapshot(
    prepareReplyToolAuthority({ run: { ...f.attempt, model: f.attempt.modelId } }),
  );
  let sourceLive = true;
  const controller = new AbortController();
  try {
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: f.scope.sessionKey,
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        receiptAuthority: () => sourceLive,
      },
      () =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          {
            ...f.attempt,
            abortSignal: controller.signal,
            userTurnTranscriptRecorder: options.noContinuation
              ? undefined
              : f.attempt.userTurnTranscriptRecorder,
            toolAuthorityFingerprint: operation?.toolAuthorityFingerprint,
          },
          undefined,
          async (prepared) => {
            const handle = {
              ...createEmbeddedRunHandle({
                runId: f.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                supportsTranscriptCommitWait: true,
              }),
              kind: "embedded" as const,
              cancel: () => {},
            };
            handle.messageInjectionV2 = {
              version: 2,
              isAvailable: () => true,
              queueMessage: async (_text, queueOptions, assertCurrent) => {
                assertCurrent();
                queueOptions?.onQueueAccepted?.(true);
                return await options.queue?.(queueOptions);
              },
            };
            setActiveEmbeddedRun(
              f.scope.sessionId,
              handle,
              f.scope.sessionKey,
              f.attempt.sessionFile,
            );
            operation?.attachBackend(handle);
            operation?.setPhase("running");
            try {
              await run({
                handle,
                operation,
                close: preparedAdmission.close,
                abort: () => controller.abort(),
                revokeSource: () => {
                  sourceLive = false;
                },
                inject: (recorder = f.B, injectionOptions = {}) => {
                  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(
                    f.scope.sessionKey,
                  );
                  if (!target) {
                    throw new Error("fixture target absent");
                  }
                  return beginReplyMessageInjectionTarget(target, "steer", {
                    waitForTranscriptCommit: true,
                    userTurnTranscriptRecorder: recorder,
                    ...injectionOptions,
                  });
                },
              });
            } finally {
              clearActiveEmbeddedRun(f.scope.sessionId, handle, f.scope.sessionKey);
            }
          },
        ),
    );
  } finally {
    preparedAdmission.close();
    operation?.complete();
  }
}

describe("registered host steering transcript transition", () => {
  it.each([false, true])(
    "refreshes both exact receipts before publication and reload continuation (reply=%s)",
    async (reply) => {
      const f = fixture();
      const original = structuredClone({
        receipt: f.A.getAdmissionReceipt(),
        message: f.A.getPersistedMessage?.(),
      });
      const B = structuredClone(f.B.getAdmissionReceipt());
      const observed: unknown[] = [];
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if (update.sessionId === f.scope.sessionId) {
          observed.push({
            A: f.A.getAdmissionReceipt(),
            B: f.B.getAdmissionReceipt(),
            message: f.A.getPersistedMessage?.(),
            fence: f.fence(f.A),
          });
        }
      });
      try {
        await runBound(
          f,
          async ({ inject }) => {
            await expect(inject().outcome).resolves.toEqual({ status: "accepted" });
            expect(f.fence(f.A)?.beforeRawSeq).toBe(original.receipt?.rawSeq);
            expect(f.fence(f.B)?.beforeRawSeq).toBe(B?.rawSeq);
          },
          { reply },
        );
      } finally {
        unsubscribe();
      }
      const generation = f.A.getAdmissionReceipt()?.generation;
      expect(generation).not.toBe(original.receipt?.generation);
      expect(f.A.getAdmissionReceipt()).toEqual({ ...original.receipt, generation });
      expect(f.A.getPersistedMessage?.()).toEqual(original.message);
      expect(f.B.getAdmissionReceipt()).toEqual({ ...B, generation });
      expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBe(f.runId);
      expect(observed).toEqual([
        expect.objectContaining({
          A: f.A.getAdmissionReceipt(),
          B: f.B.getAdmissionReceipt(),
          message: original.message,
        }),
      ]);
      // A reload starts another host attempt with the same factory recorder, not a renewed read fence.
      await runBound(f, async () => {
        expect(f.fence(f.A)).toBeDefined();
      });
    },
  );

  it("orders simultaneous confirmations against the latest committed A without changing its boundary", async () => {
    const f = fixture();
    const C = f.append("C");
    f.append("later");
    const initial = f.A.getAdmissionReceipt();
    await runBound(f, async ({ inject }) => {
      const first = inject();
      const second = inject(C);
      await expect(Promise.all([first.outcome, second.outcome])).resolves.toEqual([
        { status: "accepted" },
        { status: "accepted" },
      ]);
      expect(f.A.getAdmissionReceipt()).toEqual({
        ...initial,
        generation: C.getAdmissionReceipt()?.generation,
      });
      expect(f.B.getAdmissionReceipt()?.generation).not.toBe(C.getAdmissionReceipt()?.generation);
      expect(f.fence(f.A)?.beforeRawSeq).toBe(initial?.rawSeq);
    });
  });

  it("waits for original persistence and never confirms acceptance alone or unconfirmed transcript", async () => {
    const f = fixture();
    const settled = createDeferredCore<void | ReplyBackendQueueMessageResult>();
    const persisted = createDeferredCore();
    f.B.markRuntimePersistencePending(persisted.promise);
    const before = f.A.getAdmissionReceipt();
    await runBound(
      f,
      async ({ inject }) => {
        const pending = inject();
        await expect(pending.acceptance).resolves.toBe(true);
        expect(f.A.getAdmissionReceipt()).toEqual(before);
        settled.resolve();
        persisted.resolve();
        await expect(pending.outcome).resolves.toEqual({ status: "accepted" });
      },
      { queue: () => settled.promise },
    );
    const next = fixture();
    const original = next.A.getAdmissionReceipt();
    await runBound(
      next,
      async ({ inject }) => {
        await expect(inject().outcome).resolves.toMatchObject({
          status: "accepted",
          result: { transcriptCommit: "unconfirmed" },
        });
        expect(next.A.getAdmissionReceipt()).toEqual(original);
        expect(next.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBeUndefined();
      },
      { queue: async () => ({ transcriptCommit: "unconfirmed", errorMessage: "not settled" }) },
    );
  });

  it.each([
    "close",
    "abort",
    "source",
    "replace",
    "operation",
    "caller",
    "copy",
    "stale",
    "writer",
    "stopped",
    "blocked",
  ] as const)("does not renew receipts after %s rejection", async (reason) => {
    const f = fixture();
    const before = structuredClone([f.A.getAdmissionReceipt(), f.B.getAdmissionReceipt()]);
    const release = createDeferredCore();
    let callerLive = true;
    await runBound(
      f,
      async (owner) => {
        const pending = owner.inject(reason === "copy" ? { ...f.B } : f.B, {
          assertCurrent: () => {
            if (!callerLive) {
              throw new Error("caller revoked");
            }
          },
        });
        await pending.acceptance;
        if (reason === "close") {
          owner.close();
        }
        if (reason === "abort") {
          owner.abort();
        }
        if (reason === "source") {
          owner.revokeSource();
        }
        if (reason === "caller") {
          callerLive = false;
        }
        if (reason === "replace") {
          withoutGatewayToolCallerIdentity(() =>
            setActiveEmbeddedRun(
              f.scope.sessionId,
              createEmbeddedRunHandle({ runId: f.runId }),
              f.scope.sessionKey,
            ),
          );
        }
        if (reason === "operation") {
          owner.operation?.attachBackend({ kind: "embedded", runId: f.runId, cancel: () => {} });
        }
        if (reason === "writer") {
          replaceSessionEntrySync(f.scope, { ...f.entry, activeWriterRunId: "replacement-writer" });
        }
        if (reason === "stopped") {
          owner.handle.isStopped = () => true;
        }
        if (reason === "blocked") {
          f.B.markBlocked();
        }
        if (reason === "stale") {
          await rewriteTranscriptMessageAtAnchor(f.A.getAdmissionReceipt()!, () => ({
            ...f.A.message!,
            content: "edited A",
          }));
        }
        const refused = expect(pending.outcome).rejects.toThrow();
        release.resolve();
        await refused;
        expect([f.A.getAdmissionReceipt(), f.B.getAdmissionReceipt()]).toEqual(before);
        expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBeUndefined();
      },
      { reply: reason === "operation", queue: () => release.promise },
    );
  });

  it("composes caller revocation into the storage commit assertion", async () => {
    const f = fixture();
    let sourceLive = true;
    const create = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        create((request, grant) => {
          if (request.stage === "commit") {
            sourceLive = false;
          }
          admit(request, grant);
        }, attachment),
    );
    const before = f.A.getAdmissionReceipt();
    await runBound(f, async ({ inject }) => {
      await expect(
        inject(f.B, {
          assertCurrent: () => {
            if (!sourceLive) {
              throw new Error("source revoked at commit");
            }
          },
        }).outcome,
      ).rejects.toThrow();
      expect(f.A.getAdmissionReceipt()).toEqual(before);
      expect(f.fence(f.A)).toBeDefined();
      expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBeUndefined();
    });
  });

  it.each(["publication", "cleanup"])(
    "does not turn %s failure into replayable failure after installing both receipts",
    async (failure) => {
      const f = fixture();
      if (failure === "publication") {
        vi.spyOn(events, "publishTranscriptUpdate").mockRejectedValue(new Error("observer failed"));
      } else {
        const confirm = steeringStore.confirmSteeredUserTurnTranscript;
        vi.spyOn(steeringStore, "confirmSteeredUserTurnTranscript").mockImplementation(
          async (params) => {
            await confirm(params);
            throw new Error("post-commit cleanup failed");
          },
        );
      }
      await runBound(f, async ({ inject }) => {
        await expect(inject().outcome).resolves.toEqual({ status: "accepted" });
        expect(f.fence(f.A)).toBeDefined();
        expect(f.fence(f.B)).toBeDefined();
        expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBe(f.runId);
      });
    },
  );

  it("confirms pre-persisted input under its logical store alias", async () => {
    const f = fixture();
    const target = {
      ...f.target,
      storePath: path.join(
        path.dirname(path.dirname(f.scope.storePath)),
        "sessions",
        "sessions.json",
      ),
    };
    f.attempt.sessionTarget = target;
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {},
        withTranscriptWrite: async (run) => await run(),
      },
      () =>
        runBound(f, async ({ inject }) => {
          await expect(inject().outcome).resolves.toEqual({ status: "accepted" });
          expect(f.fence(f.A)).toBeDefined();
          expect(f.fence(f.B)).toBeDefined();
          expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBe(f.runId);
        }),
    );
  });

  it("confirms source-only steering without inventing a continuation receipt", async () => {
    const f = fixture();
    const before = f.A.getAdmissionReceipt();
    await runBound(
      f,
      async ({ inject }) => {
        await expect(inject().outcome).resolves.toEqual({ status: "accepted" });
        expect(f.A.getAdmissionReceipt()).toEqual(before);
        expect(f.fence(f.B)).toBeDefined();
        expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBe(f.runId);
      },
      { noContinuation: true },
    );
  });

  it("does not borrow A authority from a public recorder copy", async () => {
    const f = fixture();
    f.attempt.userTurnTranscriptRecorder = { ...f.A };
    const before = f.A.getAdmissionReceipt();
    await runBound(f, async ({ inject }) => {
      await expect(inject().outcome).rejects.toThrow("factory-owned continuation");
      expect(f.A.getAdmissionReceipt()).toEqual(before);
      expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBeUndefined();
    });
  });

  it("propagates original persistence failure without rewriting either receipt", async () => {
    const f = fixture();
    const failed = Promise.reject(new Error("original persistence failed"));
    failed.catch(() => undefined);
    f.B.markRuntimePersistencePending(failed);
    const before = f.A.getAdmissionReceipt();
    await runBound(f, async ({ inject }) => {
      await expect(inject().outcome).rejects.toThrow("original persistence failed");
      expect(f.A.getAdmissionReceipt()).toEqual(before);
      expect(f.fence(f.A)).toBeDefined();
      expect(f.B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBeUndefined();
    });
  });

  it("preserves ordinary no-steer admission through another prepared attempt", async () => {
    const f = fixture();
    const before = f.A.getAdmissionReceipt();
    await runBound(f, async () => {
      expect(f.fence(f.A)).toBeDefined();
    });
    await runBound(f, async () => {
      expect(f.fence(f.A)).toBeDefined();
    });
    expect(f.A.getAdmissionReceipt()).toEqual(before);
  });
});
