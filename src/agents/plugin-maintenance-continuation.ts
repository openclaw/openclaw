import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { enqueueSessionEventForHost } from "../auto-reply/reply/session-event-handoff.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-target.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureOperatorToolGatewayContinuationContextInternal } from "../gateway/server-plugin-in-process-authority.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginReplacementOutcome } from "../plugins/plugin-replacement-operation.js";
import { runOutsidePluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getReplyOperationProducerCompletion,
  registerReplyOperationSuccessorBarrier,
} from "../sessions/session-controller.barriers.js";
import { runWithSessionControllerCleanup } from "../sessions/session-controller.cleanup-context.js";
import {
  getCurrentSessionControllerOwner,
  getCurrentSessionControllerSource,
} from "../sessions/session-controller.context.js";
import type { SessionEffectRef } from "../sessions/session-controller.contracts.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import { captureSessionControllerSourceSettlement } from "../sessions/session-controller.mailbox-source.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import {
  isAcpSessionKey,
  isCronRunSessionKey,
  isSubagentSessionKey,
} from "../sessions/session-key-utils.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { isInternalRouteContext } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { captureExecRequestCancellation } from "./bash-process-control.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

export type PluginMaintenanceOutcome = { pluginIds: readonly string[] } & (
  | { ok: true }
  | { ok: false; error: string; replacement: PluginReplacementOutcome }
);
export type CapturedPluginMaintenanceContinuation = {
  owner: object;
  interrupt(assertMaintenanceCurrent: () => void): Promise<void>;
  settled: Promise<void>;
  finish(
    outcome: PluginMaintenanceOutcome,
    healthy: boolean,
    settlePluginWork: (signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  cancel(): void;
};

// An exact operation capability; ids and retention diagnostics never authorize capture.
const captures = new WeakMap<object, () => Promise<CapturedPluginMaintenanceContinuation>>();
const log = createSubsystemLogger("agents/plugin-maintenance");
export function capturePluginMaintenanceContinuation(
  owner: object,
): Promise<CapturedPluginMaintenanceContinuation> | undefined {
  return captures.get(owner)?.();
}

/** Install while the ORIGINAL admitted Gateway caller and SDK host contexts are live. */
export function registerPluginMaintenanceContinuation(
  params: Pick<EmbeddedRunAttemptParams, "sessionKey" | "sessionId" | "agentId" | "senderIsOwner">,
): () => void {
  const operation = getCurrentSessionControllerOwner();
  const source = getCurrentSessionControllerSource();
  const sessionKey = params.sessionKey;
  const agentId = params.agentId;
  const sessionId = params.sessionId;
  if (
    !operation ||
    !source?.target ||
    !source.protocolRunId ||
    !sessionKey ||
    !sessionId ||
    !agentId ||
    isAcpSessionKey(sessionKey) ||
    isCronRunSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey)
  ) {
    return () => undefined;
  }
  // Capture the callable and route now, not from the later administrator's reload context.
  const caller = getGatewayToolCallerIdentity();
  const runCapture = AsyncLocalStorage.snapshot();
  let captured: Promise<CapturedPluginMaintenanceContinuation> | undefined;
  const capture = () =>
    (captured ??= runCapture(async () => {
      if (operation.result) {
        // A completed reply may still retain physical cleanup, but owns no work to resume.
        return {
          owner: operation,
          settled: Promise.all([
            getReplyOperationProducerCompletion(operation),
            captureSessionControllerSourceSettlement(source),
          ]).then(() => undefined),
          interrupt: async () => {},
          finish: async () => {},
          cancel: () => {},
        };
      }
      operation.abortSignal.throwIfAborted();
      const continuation = await captureOperatorToolGatewayContinuationContextInternal(
        { sessionKey, agentId: params.agentId },
        { retainRequester: true },
      );
      if (!continuation) {
        throw new Error("The native run has no resumable admitted requester");
      }
      const barrier = createDeferredCore();
      const commandCleanup = createDeferredCore();
      const lifetime = new AbortController();
      let custody: SessionEffectRef | undefined;
      let interrupted = false;
      let finished = false;
      let released = false;
      let accepted = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        if (!interrupted) {
          commandCleanup.resolve(undefined);
        }
        captured = undefined;
        continuation.signal.removeEventListener("abort", cancel);
        continuation.release();
        custody?.release();
        barrier.resolve(undefined);
      };
      const cancel = () => {
        lifetime.abort(new Error("Plugin maintenance continuation cancelled"));
        release();
      };
      continuation.signal.addEventListener("abort", cancel, { once: true });
      try {
        continuation.assertCurrent();
        const target = await continuation.runWithRequester(() =>
          captureSessionEventTargetForHost(agentId, sessionKey, {
            assertCurrent: continuation.assertCurrent,
            operatorAuthority: continuation.operatorAuthority,
            ...(params.senderIsOwner ? { ownerContinuation: true as const } : {}),
          }),
        );
        if (!target.storePath || target.sessionId !== params.sessionId) {
          throw new Error("The native run's session changed before maintenance capture");
        }
        // The admitted turn route, not the session's historical external recipient,
        // decides where a privately initiated continuation may be delivered.
        const internalResume =
          !target.deliveryContext?.channel ||
          (isInternalRouteContext({ channel: caller?.turnSourceChannel }) &&
            (!caller?.turnSourceTo || caller.turnSourceTo === sessionKey));
        await withSessionEntryReadOnlyInWorker(
          { agentId, storePath: target.storePath, sessionKey },
          continuation.assertCurrent,
          async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            if (read.value?.incognito) {
              throw new Error("Incognito runs cannot resume after plugin maintenance");
            }
          },
        );
        const stopCapture = captureSessionControllerStop({
          inputs: [source],
          operations: [operation],
        });
        const commands = captureExecRequestCancellation({
          agentId,
          sessionKey,
          sessionId,
          runId: source.protocolRunId,
        });
        // Detached exec receipts are not producer settlement. Join cancellation through
        // the existing operation cleanup owner before maintenance can release plugin leases.
        operation.registerExecutionCleanup(async () => {
          if (interrupted) {
            await commandCleanup.promise;
          }
        });
        const adapter = source.sourceAdapter;
        custody = await runWithSessionControllerCleanup(() =>
          beginSessionEffect({
            target: source.target!,
            run: {
              runId: source.protocolRunId!,
              sessionKey,
              sessionId: params.sessionId,
              agentId: params.agentId,
              abortAuthority: {
                requester: adapter?.requester,
                initiatingPersonalOperator: adapter?.initiatingPersonalOperator,
              },
            },
            onInterrupt: () => cancel(),
            signal: lifetime.signal,
          }),
        );
        operation.abortSignal.throwIfAborted();
        continuation.assertCurrent();
        const settled = Promise.all([
          getReplyOperationProducerCompletion(operation),
          captureSessionControllerSourceSettlement(source),
          commandCleanup.promise,
        ]).then(() => undefined);
        const handle: CapturedPluginMaintenanceContinuation = {
          owner: operation,
          settled,
          cancel,
          async interrupt(assertMaintenanceCurrent) {
            if (
              interrupted ||
              finished ||
              lifetime.signal.aborted ||
              operation.abortSignal.aborted ||
              operation.result ||
              operation.abortFrozen ||
              operation.admissionRetired
            ) {
              return;
            }
            const assertInterruptCurrent = () => {
              assertMaintenanceCurrent();
              continuation.assertCurrent();
            };
            assertInterruptCurrent();
            registerReplyOperationSuccessorBarrier({
              operation,
              sessionId,
              sessionKeys: [sessionKey],
              start: () => barrier.promise,
            });
            // Set before synchronous abort listeners run; this abort alone preserves the mailbox FIFO.
            interrupted = true;
            try {
              commands.cancel(() => {
                assertInterruptCurrent();
                return true;
              });
            } finally {
              void commands.settle().then(
                () => commandCleanup.resolve(undefined),
                (error: unknown) => commandCleanup.reject(error),
              );
            }
            await stopSession({
              source: "maintenance",
              capture: stopCapture,
              assertCurrent: assertInterruptCurrent,
              reason: new Error("Plugin maintenance interrupted this unfinished turn"),
            }).completed;
          },
          async finish(outcome, healthy, settlePluginWork) {
            if (finished) {
              return;
            }
            finished = true;
            if (!interrupted || lifetime.signal.aborted) {
              release();
              return;
            }
            if (!healthy) {
              // Failed activation or restoration cannot admit queued work. Stop/revocation
              // retains ownership of cancelling this process-local successor fence.
              log.warn(
                "Plugin maintenance left the runtime unhealthy; successor admission remains closed.",
              );
              return;
            }
            const delivery = runInDetachedAsyncContext(async () => {
              try {
                await settled;
                // A Code Mode bridge can abort before its underlying plugin promise settles.
                // Only the selected generation can confirm that physical work is gone.
                await settlePluginWork(lifetime.signal);
              } catch (error) {
                log.warn(
                  `Plugin maintenance cleanup was not confirmed; successors remain fenced: ${String(error)}`,
                );
                return;
              }
              try {
                if (lifetime.signal.aborted) {
                  return;
                }
                lifetime.signal.throwIfAborted();
                continuation.assertCurrent();
                // Old execution is physically settled and the replacement is healthy.
                // Dispatch prepares before returning its queue receipt; retaining this
                // execution fence until that receipt would deadlock the existing mailbox.
                // The retained effect still owns this producer through accepted delivery.
                barrier.resolve(undefined);
                const receipt = await continuation.runWithRequester(async () =>
                  runWithSessionControllerCleanup(() =>
                    runOutsidePluginRuntimeRegistryScope(() =>
                      enqueueSessionEventForHost(
                        "Plugin maintenance " +
                          (outcome.ok
                            ? "completed"
                            : outcome.replacement.committed
                              ? "applied"
                              : outcome.replacement.kind === "restored"
                                ? "rolled back"
                                : "not applied") +
                          " for " +
                          outcome.pluginIds.join(", ") +
                          ". Continue the unfinished work in this conversation from its saved transcript. Preserve completed tool results; do not replay completed external actions." +
                          (!outcome.ok ? " Maintenance result: " + outcome.error : ""),
                        {
                          agentId,
                          sessionKey,
                          source: "tool_handoff",
                          sourceRunId: source.protocolRunId,
                          expectedTarget: target,
                          abortSignal: lifetime.signal,
                          sourceTurnId: "plugin-maintenance:" + randomUUID(),
                          ...(internalResume
                            ? { deliveryContext: { channel: INTERNAL_MESSAGE_CHANNEL } }
                            : {}),
                        },
                      ),
                    ),
                  ),
                );
                const result = await receipt.accepted;
                if (!result.ok) {
                  throw new Error(
                    "Plugin maintenance continuation was not accepted: " + result.error,
                  );
                }
                accepted = true;
                // The original requester remains live through the accepted execution.
                void receipt.settled.finally(release).catch(() => undefined);
              } catch (error) {
                // Stop or current-authority changes intentionally suppress this requester,
                // without changing the already-published plugin outcome for other owners.
                log.warn(`Plugin maintenance continuation not delivered: ${String(error)}`);
              } finally {
                if (!accepted) {
                  release();
                }
              }
            });
            // Existing effect custody owns delivery after the bounded reload has returned,
            // including an uncooperative plugin promise still cleaning up after timeout.
            void delivery.catch((error: unknown) => log.warn(String(error)));
          },
        };
        // Normal completion never creates a wakeup; ordinary Stop before maintenance cancels capture.
        const onAbort = () => {
          if (!interrupted) {
            cancel();
          }
        };
        operation.abortSignal.addEventListener("abort", onAbort, { once: true });
        void settled
          .finally(() => {
            operation.abortSignal.removeEventListener("abort", onAbort);
            if (!interrupted) {
              release();
            }
          })
          .catch(() => undefined);
        return handle;
      } catch (error) {
        cancel();
        throw error;
      }
    }));
  captures.set(operation, capture);
  return () => {
    // Keep the exact owner discoverable through cleanup after its native attempt returns.
    void getReplyOperationProducerCompletion(operation)
      .finally(() => {
        if (captures.get(operation) === capture) {
          captures.delete(operation);
        }
      })
      .catch(() => undefined);
  };
}
