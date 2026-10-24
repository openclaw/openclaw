import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { setActiveEmbeddedRun as publishHarnessActiveEmbeddedRun } from "../../plugin-sdk/agent-harness-runtime.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.message-injection.js";
import { captureReplyMessageJoinObservation } from "../../sessions/session-controller.message-join-observation.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import {
  captureReplyToolAuthorityCallerBinding,
  type ReplyToolAuthorityContinuation,
} from "./host-private-capabilities.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";
import {
  admitted,
  attempt,
  createDirectReplyOperation,
  sessionId,
  sessionKey,
} from "./tool-authority.runtime.test-support.js";

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

type Admission = Parameters<Parameters<typeof admitted>[0]>[0];
async function withOperation(
  run: (context: Admission & { operation: ReplyOperation }) => Promise<void>,
  create = createDirectReplyOperation,
) {
  await admitted(async (context) => {
    const operation = create();
    try {
      await run({ ...context, operation });
    } finally {
      operation.complete();
    }
  });
}

const publish = (handle: Parameters<typeof publishHarnessActiveEmbeddedRun>[1]) =>
  publishHarnessActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
const joinObservation = () =>
  captureReplyMessageJoinObservation({ run: attempt, sessionEntry: undefined });

describe("host-prepared embedded tool authority", () => {
  it.each([
    ["current", "inherited"],
    ["current", "materialized"],
    ["closed-during-preparation", "inherited"],
  ] as const)(
    "allows direct harness execution only under current prepared authority (%s, %s)",
    async (authority, source) => {
      await admitted(async ({ admittedRunContext, close }) => {
        const operation = source === "inherited" ? createDirectReplyOperation() : undefined;
        let observed: ReplyOperation | undefined;
        const run = vi.fn(
          async (prepared: {
            replyOperation?: ReplyOperation;
            toolAuthorityFingerprint?: string;
          }) => {
            observed = prepared.replyOperation;
            expect(observed).toBe(getSessionControllerOperation(sessionKey));
            if (operation) {
              expect(observed).toBe(operation);
            }
            const handle = createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
            });
            expect(() => withoutGatewayToolCallerIdentity(() => publish(handle))).toThrow(
              "host-admitted",
            );
            const cleanup = publish(handle);
            cleanup?.();
            return "entered";
          },
        );
        try {
          const pending = withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext, replyOperation: operation },
            attempt,
            (input) => {
              if (authority === "closed-during-preparation") {
                close();
              }
              return input;
            },
            run,
          );
          if (authority === "current") {
            await expect(pending).resolves.toBe("entered");
            if (operation) {
              // A borrowed turn stays live, but its completed attempt must release the snapshot.
              await expect(
                operation.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-test" }),
              ).rejects.toThrow("Reply operation has no active tool authority snapshot");
            }
          } else {
            await expect(pending).rejects.toThrow("admitted run authority is no longer active");
            expect(run).not.toHaveBeenCalled();
          }
        } finally {
          operation?.complete();
        }
        if (authority === "current") {
          await expect(
            observed?.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-test" }),
          ).rejects.toThrow("Reply operation authority is no longer active");
          expect(() => publish(createEmbeddedRunHandle({ runId: attempt.runId }))).toThrow(
            "host-admitted",
          );
        }
      });
    },
  );

  it("retries direct authority preparation after a failed snapshot bind", async () => {
    await withOperation(async ({ admittedRunContext, operation }) => {
      const internal = {
        admittedRunContext,
        replyOperation: operation,
        joinObservation: joinObservation(),
      };
      const failedRun = vi.fn(async () => {});
      const failure = new Error("policy preparation failed");
      await expect(
        withPreparedEmbeddedRunToolAuthority(
          internal,
          attempt,
          () => {
            throw failure;
          },
          failedRun,
        ),
      ).rejects.toBe(failure);
      expect(failedRun).not.toHaveBeenCalled();
      await expect(
        withPreparedEmbeddedRunToolAuthority(internal, attempt, undefined, async (prepared) => {
          const cleanup = publish(
            createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
            }),
          );
          cleanup?.();
          return "retried";
        }),
      ).resolves.toBe("retried");
    });
  });

  it.each(["cancel-target", "replace-target", "cancel-both"] as const)(
    "preserves valid source fallback when projection loses its target (%s)",
    async (transition) => {
      await withOperation(async ({ admittedRunContext, operation }) => {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          attempt,
          undefined,
          async (prepared) => {
            const queue = vi.fn(async () => {});
            const handle = createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              guarded: true,
              queueMessage: queue,
            });
            const releaseHandle = publish(handle);
            const target = captureCurrentReplyMessageInjectionTarget(sessionKey)!;
            const entered = createDeferred();
            const resume = createDeferred();
            const project = operation.projectToolAuthorityFingerprintAsync;
            vi.spyOn(operation, "projectToolAuthorityFingerprintAsync").mockImplementation(
              async (overlay) => {
                const fingerprint = await project(overlay);
                entered.resolve();
                await resume.promise;
                return fingerprint;
              },
            );
            const source = new AbortController();
            const sourceError = new Error("incoming source cancelled");
            const pending = beginReplyMessageInjectionTarget(target, "retained input", {
              isInboundUserMessage: true,
              toolAuthorityOverlay: {
                messageProvider: "webchat",
                senderId: "authority-requester",
                senderIsOwner: true,
                disableTools: false,
                traceAuthorized: false,
              },
              assertCurrent: () => source.signal.throwIfAborted(),
            });
            let releaseReplacement: (() => void) | undefined;
            try {
              await awaitGateBeforeSettlement(entered.promise, pending, "Projection not reached");
              if (transition === "replace-target") {
                releaseReplacement = publish({ ...handle });
              } else {
                operation.abortByUser();
                if (transition === "cancel-both") {
                  source.abort(sourceError);
                }
              }
              resume.resolve();
              const injection = await pending;
              await expect(injection.acceptance).resolves.toBe(false);
              await expect(injection.outcome).resolves.toEqual(
                transition === "cancel-both"
                  ? { status: "failed", error: sourceError }
                  : {
                      status: "rejected",
                      reason: transition === "replace-target" ? "no_active_run" : "not_running",
                    },
              );
              expect(queue).not.toHaveBeenCalled();
            } finally {
              resume.resolve();
              await Promise.allSettled([pending]);
              releaseReplacement?.();
              releaseHandle?.();
            }
          },
        );
      });
    },
  );

  it("prepares direct successor attempts on one controller and revokes retained attempt authority", async () => {
    await withOperation(async ({ admittedRunContext, operation }) => {
      let previousCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
      let previousFingerprint: string | undefined;
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext, replyOperation: operation },
        attempt,
        undefined,
        async (prepared) => {
          previousCaller = getGatewayToolCallerIdentity();
          previousFingerprint = prepared.toolAuthorityFingerprint;
        },
      );
      const successorId = `${sessionId}-successor`;
      operation.updateSessionId(successorId);
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext, replyOperation: operation },
        { ...attempt, sessionId: successorId },
        undefined,
        async (prepared) => {
          expect(prepared.replyOperation).toBe(operation);
          await expect(
            withoutGatewayToolCallerIdentity(() =>
              withGatewayToolCallerIdentity(previousCaller, () =>
                publish(
                  createEmbeddedRunHandle({
                    runId: attempt.runId,
                    toolAuthorityFingerprint: previousFingerprint,
                  }),
                ),
              ),
            ),
          ).rejects.toThrow("no longer active");
        },
      );
    });
  });

  it("revokes a selected continuation when an equivalent-policy attempt replaces its snapshot", async () => {
    await withOperation(async ({ admittedRunContext, operation }) => {
      const observation = joinObservation();
      const internal = {
        admittedRunContext,
        replyOperation: operation,
        joinObservation: observation,
      };
      const continuation: ReplyToolAuthorityContinuation = {
        kind: "continuation",
        caller: {
          senderIsOwner: true,
          disableTools: false,
          messageProvider: attempt.messageProvider,
          senderId: attempt.senderId,
        },
        config: attempt.config,
        executionSelection: observation.executionSelection,
        selectedRoute: { provider: attempt.provider, model: attempt.modelId },
        fallbackAvailability: { kind: "none_configured", source: "inherited" },
      };
      const capture = () =>
        captureReplyToolAuthorityCallerBinding(
          operation.projectToolAuthorityFingerprintAsync,
          continuation,
          operation.toolAuthorityFingerprint,
          undefined,
          () => {},
        );
      let previous: ReturnType<typeof capture>;
      let previousFingerprint: string | undefined;
      await withPreparedEmbeddedRunToolAuthority(internal, attempt, undefined, async (prepared) => {
        previousFingerprint = prepared.toolAuthorityFingerprint;
        previous = capture();
        await expect(previous?.prepare()).resolves.toBeDefined();
      });
      await withPreparedEmbeddedRunToolAuthority(internal, attempt, undefined, async (prepared) => {
        expect(prepared.toolAuthorityFingerprint).toBe(previousFingerprint);
        // Neither attempt attaches a backend: rejection must come from the selected policy owner.
        await expect(previous?.prepare()).rejects.toThrow("no longer active");
        await expect(capture()?.prepare()).resolves.toBeDefined();
      });
    });
  });

  it.each(["caller", "controller"] as const)(
    "passes borrowed-turn cancellation from the %s to the harness attempt",
    async (source) => {
      await withOperation(
        async ({ admittedRunContext, operation }) => {
          const caller = new AbortController();
          await withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext, replyOperation: operation },
            { ...attempt, abortSignal: caller.signal },
            undefined,
            async (prepared) => {
              expect(prepared.abortSignal.aborted).toBe(false);
              if (source === "caller") {
                caller.abort(new Error("caller cancelled"));
              } else {
                operation.abortByUser();
              }
              expect(prepared.abortSignal.aborted).toBe(true);
            },
          );
        },
        () => createReplyOperation({ sessionId, sessionKey, resetTriggered: false }),
      );
    },
  );
});
