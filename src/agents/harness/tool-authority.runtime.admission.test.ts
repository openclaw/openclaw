import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { setActiveEmbeddedRun as publishHarnessActiveEmbeddedRun } from "../../plugin-sdk/agent-harness-runtime.js";
import { bindPluginGatewayAccessPolicy } from "../../plugins/gateway-access-policy-registration.js";
import { createOwnedTestInstance } from "../../plugins/plugin-instance.test-support.js";
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
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import * as requesterOrigin from "../requester-origin.js";
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
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

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
const preparedHandle = (toolAuthorityFingerprint: string | undefined) =>
  createEmbeddedRunHandle({ runId: attempt.runId, toolAuthorityFingerprint });
const joinObservation = () =>
  captureReplyMessageJoinObservation({ run: attempt, sessionEntry: undefined });

type AuthorityRead = { key: PropertyKey; present: boolean; value: unknown };
function observeReads<T extends object>(target: T, reads: AuthorityRead[]): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      reads.push({ key, present: Object.hasOwn(object, key), value });
      return value;
    },
  });
}

describe("host-prepared embedded tool authority", () => {
  it.each([false, true])(
    "preserves requester capture reads with inherited requester=%s",
    async (inherited) => {
      const optionalFacts = [
        "agentAccountId",
        "operatorProfileId",
        "messageChannel",
        "chatType",
        "conversationId",
        "messageThreadId",
        "groupId",
        "groupChannel",
        "groupSpace",
        "senderName",
        "senderUsername",
        "senderE164",
      ] as const satisfies readonly (keyof AgentHarnessAttemptParamsV2)[];
      const params: Parameters<typeof withPreparedEmbeddedRunToolAuthority>[1] = {
        ...Object.fromEntries(optionalFacts.map((key) => [key, undefined])),
        ...attempt,
        requesterOrigin: inherited
          ? {
              sessionKey: "agent:main:original",
              operatorProfileId: "original-profile",
              delegatedCreatorProfileId: "delegating-profile",
              messageProvider: "telegram",
              accountId: "original-account",
              chatType: "group" as const,
              senderId: "original-sender",
            }
          : undefined,
        sandboxSessionKey: "",
        senderName: "Current Sender",
        senderE164: null,
        conversationId: "current-conversation",
      };
      // This callee read is intentionally absent: delegation lives in requesterOrigin,
      // never in the attempt's top-level contract. The type probe fails if that changes.
      const absentRequesterKeys: Extract<
        keyof AgentHarnessAttemptParamsV2,
        "delegatedCreatorProfileId"
      > extends never
        ? readonly ["delegatedCreatorProfileId"]
        : never = ["delegatedCreatorProfileId"];
      const capture = requesterOrigin.captureRequesterOrigin;
      const originSpy = vi
        .spyOn(requesterOrigin, "captureRequesterOrigin")
        .mockImplementationOnce((input) => {
          const legacyReads: AuthorityRead[] = [];
          const projectedReads: AuthorityRead[] = [];
          const legacy = capture(
            observeReads({ ...params, operatorProfileId: input.operatorProfileId }, legacyReads),
          );
          const projected = capture(observeReads(input, projectedReads));
          expect(projectedReads).toEqual(legacyReads);
          expect([
            ...new Set(projectedReads.filter((read) => !read.present).map((read) => read.key)),
          ]).toEqual(inherited ? [] : absentRequesterKeys);
          expect(projected).toEqual(legacy);
          return projected;
        });
      await admitted(async ({ admittedRunContext }) => {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, sessionPersistence: "detached" },
          params,
          undefined,
          async () => {
            const caller = getGatewayToolCallerIdentity();
            expect(caller?.requesterOrigin?.senderId).toBe(
              inherited ? "original-sender" : params.senderId,
            );
            expect(caller?.receiptAuthority).toBeTypeOf("function");
            caller?.receiptAuthority?.();
          },
        );
      });
      expect(originSpy).toHaveBeenCalled();
    },
  );

  it.each([
    ["current", "inherited"],
    ["current", "materialized"],
    ["closed-during-preparation", "inherited"],
  ] as const)(
    "allows direct harness execution only under current prepared authority (%s, %s)",
    async (authority, source) => {
      const revocation = new AbortController();
      const check = vi.fn(() => revocation.signal.throwIfAborted());
      const profile = { profileId: "watchdog-person", emails: [], assignedRole: null };
      const operator = createAdmittedRunOperatorAuthority({
        profileId: "watchdog-person",
        scopes: ["operator.write"],
        ...bindPluginGatewayAccessPolicy(
          { authorize: () => ({ assertCurrent: check, signal: new AbortController().signal }) },
          createOwnedTestInstance("watchdog-access"),
        ).authorize({ config: {}, profile, requiredByRole: true })!,
      });
      await admitted(async ({ admittedRunContext, close }) => {
        const operation = source === "inherited" ? createDirectReplyOperation() : undefined;
        const readContinuation = vi.fn(() => ({ prompt: "synthetic continuation" }));
        const internal = {
          admittedRunContext,
          replyOperation: operation,
          get continuation() {
            return readContinuation();
          },
        };
        const params: Parameters<typeof withPreparedEmbeddedRunToolAuthority>[1] = Object.freeze({
          ...attempt,
          abortSignal: undefined,
        });
        let observed: ReplyOperation | undefined;
        const run = vi.fn(
          async (prepared: {
            replyOperation?: ReplyOperation;
            toolAuthorityFingerprint?: string;
            abortSignal?: AbortSignal;
          }) => {
            observed = prepared.replyOperation;
            expect(observed).toBe(getSessionControllerOperation(sessionKey));
            if (operation) {
              expect(prepared.replyOperation).toBe(operation);
            }
            expect(prepared.abortSignal).toBe(observed!.abortSignal);
            expect(prepared.abortSignal?.aborted).toBe(false);
            expect(params.abortSignal).toBeUndefined();
            const handle = preparedHandle(prepared.toolAuthorityFingerprint);
            const watchdog = getGatewayToolCallerIdentity()!.watchdogAttempt!;
            check.mockClear();
            expect(watchdog.progressModel()).toBe(true);
            watchdog.toolEvent({ phase: "start", toolCallId: "tool", toolName: "read" });
            expect(watchdog.progressTool("tool", ["read"])).toBe(true);
            watchdog.toolEvent({ phase: "end", toolCallId: "tool", toolName: "read" });
            await observed!.watchdog.tick();
            expect(check).not.toHaveBeenCalled();
            expect(() => withoutGatewayToolCallerIdentity(() => publish(handle))).toThrow(
              "host-admitted",
            );
            const cleanup = publish(handle);
            try {
              revocation.abort(new Error("Plugin grant revoked")); // The exposed signal stays live.
              expect(() => publish(handle)).toThrow("no longer active");
              expect(watchdog.isCurrent()).toBe(false);
            } finally {
              cleanup?.();
            }
            return "entered";
          },
        );
        try {
          const pending = withPreparedEmbeddedRunToolAuthority(
            internal,
            params,
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
        expect(readContinuation).not.toHaveBeenCalled();
        if (authority === "current") {
          await expect(
            observed?.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-test" }),
          ).rejects.toThrow("Reply operation authority is no longer active");
          expect(() => publish(createEmbeddedRunHandle({ runId: attempt.runId }))).toThrow(
            "host-admitted",
          );
        }
      }, operator);
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
          const cleanup = publish(preparedHandle(prepared.toolAuthorityFingerprint));
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
      const internal = { admittedRunContext, replyOperation: operation };
      let previousCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
      let previousFingerprint: string | undefined;
      await withPreparedEmbeddedRunToolAuthority(internal, attempt, undefined, async (prepared) => {
        previousCaller = getGatewayToolCallerIdentity();
        previousFingerprint = prepared.toolAuthorityFingerprint;
      });
      const successorId = `${sessionId}-successor`;
      operation.updateSessionId(successorId);
      await withPreparedEmbeddedRunToolAuthority(
        internal,
        { ...attempt, sessionId: successorId },
        undefined,
        async (prepared) => {
          expect(prepared.replyOperation).toBe(operation);
          await expect(
            withoutGatewayToolCallerIdentity(() =>
              withGatewayToolCallerIdentity(previousCaller, () =>
                publish(preparedHandle(previousFingerprint)),
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
