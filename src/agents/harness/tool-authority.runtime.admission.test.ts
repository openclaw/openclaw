import { afterEach, expect, it, vi } from "vitest";
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

type Admission = Parameters<Parameters<typeof admitted>[0]>[0];
type Prepared = Parameters<Parameters<typeof withPreparedEmbeddedRunToolAuthority>[3]>[0];
type Prepare = <T>(
  run: (prepared: Prepared) => Promise<T>,
  params?: Partial<typeof attempt> & { abortSignal?: AbortSignal },
) => Promise<T>;
const route = { provider: "openai", model: "gpt-test" };
async function withOperation(
  run: (context: Admission & { operation: ReplyOperation; prepare: Prepare }) => Promise<void>,
  direct = true,
) {
  return admitted(async (context) => {
    const operation = createReplyOperation({
      sessionId,
      sessionKey,
      resetTriggered: false,
      ...(direct ? { turnKind: "direct" as const } : {}),
    });
    try {
      const prepare: Prepare = (execute, params = {}) =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext: context.admittedRunContext, replyOperation: operation },
          { ...attempt, ...params },
          undefined,
          execute,
        );
      await run({ ...context, operation, prepare });
    } finally {
      operation.complete();
    }
  });
}

function publish(handle: Parameters<typeof publishHarnessActiveEmbeddedRun>[1]) {
  return publishHarnessActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
}

it.each([
  ["current", "inherited"],
  ["current", "materialized"],
  ["closed-during-preparation", "inherited"],
] as const)("executes only under current host authority (%s, %s)", async (authority, source) => {
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
    const run = vi.fn(async (prepared: Prepared) => {
      observed = prepared.replyOperation;
      expect(observed).toBeDefined();
      expect(observed).toBe(getSessionControllerOperation(sessionKey));
      if (operation) {
        expect(observed).toBe(operation);
      }
      return "entered";
    });
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
          await expect(operation.bindToolAuthorityRouteAsync(route)).rejects.toThrow(
            "Reply operation has no active tool authority snapshot",
          );
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
      await expect(observed?.bindToolAuthorityRouteAsync(route)).rejects.toThrow(
        "Reply operation authority is no longer active",
      );
    }
  });
});

it.each(["cancel-target", "replace-target", "cancel-both"] as const)(
  "preserves source fallback after projection loses its target (%s)",
  async (transition) => {
    await withOperation(async ({ operation, prepare }) => {
      await prepare(async (prepared) => {
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
      });
    });
  },
);

it("revokes prior attempt authority when preparing a successor", async () => {
  await withOperation(async ({ operation, prepare }) => {
    let previousCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
    let previousFingerprint: string | undefined;
    await prepare(async (prepared) => {
      previousCaller = getGatewayToolCallerIdentity();
      previousFingerprint = prepared.toolAuthorityFingerprint;
      expect(operation.toolAuthorityFingerprint).toBe(previousFingerprint);
    });
    expect(operation.toolAuthorityFingerprint).toBeUndefined();
    const successorId = `${sessionId}-successor`;
    operation.updateSessionId(successorId);
    await prepare(
      async (prepared) => {
        expect(prepared.replyOperation).toBe(operation);
        expect(operation.toolAuthorityFingerprint).toBe(prepared.toolAuthorityFingerprint);
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
      { sessionId: successorId },
    );
    expect(operation.toolAuthorityFingerprint).toBeUndefined();
  });
});

it.each(["caller", "controller"] as const)(
  "propagates borrowed-turn %s cancellation",
  async (source) => {
    await withOperation(async ({ operation, prepare }) => {
      const caller = new AbortController();
      await prepare(
        async (prepared) => {
          expect(prepared.abortSignal).toMatchObject({ aborted: false });
          if (source === "caller") {
            caller.abort(new Error("caller cancelled"));
          } else {
            operation.abortByUser();
          }
          expect(prepared.abortSignal).toMatchObject({ aborted: true });
        },
        { abortSignal: caller.signal },
      );
    }, false);
  },
);
