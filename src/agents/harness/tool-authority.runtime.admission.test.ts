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
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";
import { admitted, attempt, sessionId, sessionKey } from "./tool-authority.runtime.test-support.js";

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

describe("host-prepared embedded tool authority", () => {
  it.each([
    ["current", "inherited"],
    ["current", "materialized"],
    ["closed-during-preparation", "inherited"],
  ] as const)(
    "allows direct harness execution only under current prepared authority (%s, %s)",
    async (authority, source) => {
      await admitted(async ({ admittedRunContext, close }) => {
        const operation =
          source === "inherited"
            ? createReplyOperation({
                sessionId,
                sessionKey,
                resetTriggered: false,
                turnKind: "direct",
              })
            : undefined;
        let observed: ReplyOperation | undefined;
        const run = vi.fn(
          async (prepared: {
            replyOperation?: ReplyOperation;
            toolAuthorityFingerprint?: string;
          }) => {
            observed = prepared.replyOperation;
            expect(observed).toBeDefined();
            expect(observed).toBe(getSessionControllerOperation(sessionKey));
            if (operation) {
              expect(observed).toBe(operation);
            }
            const handle = createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
            });
            const publish = () =>
              publishHarnessActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
            expect(() => withoutGatewayToolCallerIdentity(publish)).toThrow("host-admitted");
            const cleanup = publish();
            expect(cleanup).toBeTypeOf("function");
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
            expect(run).toHaveBeenCalledOnce();
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
          expect(observed?.toolAuthorityFingerprint).toBeUndefined();
          expect(observed?.toolAuthorityRoute).toBeUndefined();
          await expect(
            observed?.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-test" }),
          ).rejects.toThrow("Reply operation authority is no longer active");
          expect(() =>
            publishHarnessActiveEmbeddedRun(
              sessionId,
              createEmbeddedRunHandle({ runId: attempt.runId }),
              sessionKey,
              attempt.sessionFile,
            ),
          ).toThrow("host-admitted");
        }
      });
    },
  );

  it.each(["cancel-target", "replace-target", "cancel-both"] as const)(
    "preserves valid source fallback when projection loses its target (%s)",
    async (transition) => {
      await admitted(async ({ admittedRunContext }) => {
        const operation = createReplyOperation({
          sessionId,
          sessionKey,
          resetTriggered: false,
          turnKind: "direct",
        });
        try {
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
              const releaseHandle = publishHarnessActiveEmbeddedRun(
                sessionId,
                handle,
                sessionKey,
                attempt.sessionFile,
              );
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
                  releaseReplacement = publishHarnessActiveEmbeddedRun(
                    sessionId,
                    { ...handle },
                    sessionKey,
                    attempt.sessionFile,
                  );
                } else {
                  operation.abortByUser();
                  if (transition === "cancel-both") {
                    source.abort(sourceError);
                  }
                }
                resume.resolve();
                if (transition === "cancel-both") {
                  await expect(pending).rejects.toBe(sourceError);
                } else {
                  const injection = await pending;
                  await expect(injection.acceptance).resolves.toBe(false);
                  await expect(injection.outcome).resolves.toEqual({
                    status: "rejected",
                    reason: transition === "replace-target" ? "no_active_run" : "not_running",
                  });
                }
                expect(queue).not.toHaveBeenCalled();
              } finally {
                resume.resolve();
                await Promise.allSettled([pending]);
                releaseReplacement?.();
                releaseHandle?.();
              }
            },
          );
        } finally {
          operation.complete();
        }
      });
    },
  );

  it("prepares direct successor attempts on one controller and revokes retained attempt authority", async () => {
    await admitted(async ({ admittedRunContext }) => {
      const operation = createReplyOperation({
        sessionId,
        sessionKey,
        resetTriggered: false,
        turnKind: "direct",
      });
      let previousCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
      let previousFingerprint: string | undefined;
      try {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          attempt,
          undefined,
          async (prepared) => {
            previousCaller = getGatewayToolCallerIdentity();
            previousFingerprint = prepared.toolAuthorityFingerprint;
            expect(operation.toolAuthorityFingerprint).toBe(previousFingerprint);
          },
        );
        expect(operation.toolAuthorityFingerprint).toBeUndefined();
        const successorId = `${sessionId}-successor`;
        operation.updateSessionId(successorId);
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          { ...attempt, sessionId: successorId },
          undefined,
          async (prepared) => {
            expect(prepared.replyOperation).toBe(operation);
            expect(operation.toolAuthorityFingerprint).toBe(prepared.toolAuthorityFingerprint);
            await expect(
              withoutGatewayToolCallerIdentity(() =>
                withGatewayToolCallerIdentity(previousCaller, () =>
                  publishHarnessActiveEmbeddedRun(
                    sessionId,
                    createEmbeddedRunHandle({
                      runId: attempt.runId,
                      toolAuthorityFingerprint: previousFingerprint,
                    }),
                    sessionKey,
                    attempt.sessionFile,
                  ),
                ),
              ),
            ).rejects.toThrow("no longer active");
          },
        );
        expect(operation.toolAuthorityFingerprint).toBeUndefined();
      } finally {
        operation.complete();
      }
    });
  });

  it.each(["caller", "controller"] as const)(
    "passes borrowed-turn cancellation from the %s to the harness attempt",
    async (source) => {
      await admitted(async ({ admittedRunContext }) => {
        const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
        const caller = new AbortController();
        try {
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
        } finally {
          operation.complete();
        }
      });
    },
  );
});
