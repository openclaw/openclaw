// Exercises the automatic sender with real task/session stores and recording transport.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureCommandOwnerAssertion } from "../../auto-reply/command-owner-authority.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as transcriptReads from "../../config/sessions/session-accessor.sqlite-active-events.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainPendingDeliveriesCore } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries as loadPendingDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { createRecoveryLog } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createAgentHarnessTaskRuntime } from "../../plugin-sdk/agent-harness-task-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureHarnessCompletionRecovery } from "../../tasks/agent-harness-completion-recovery.js";
import { createAgentHarnessTaskRuntimeScope } from "../../tasks/agent-harness-task-runtime-scope.js";
import { getTaskById, markTaskTerminalById } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { bindCommandHarnessCompletionAssertion } from "../agent-command-restart-recovery.js";
import { reconcileHarnessCompletionDelivery } from "../agent-harness-completion-delivery.js";
import { resolveSourceReplyDelivery } from "../embedded-agent-runner/delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { deliverAgentCommandResult } from "./delivery.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetTaskRegistryForTests();
});

describe("native completion final-send custody", () => {
  for (const boundary of [
    "reply hook",
    "adapter preparation",
    "queued retry",
    "queued after cleanup",
    "restart onPlatformSendDispatch",
    "restart assertDirectAdapterHandoff",
    "source read onPlatformSendDispatch",
    "source read assertDirectAdapterHandoff",
  ] as const) {
    const restart = boundary.startsWith("restart");
    const readFailure = boundary.startsWith("source read");
    const handoff = restart || readFailure;
    const authorizationOutcomes = readFailure
      ? (["source-interleaved", "owner-bound-source-interleaved"] as const)
      : restart
        ? ([
            "unchanged",
            "source-interleaved",
            "owner-bound-unchanged",
            "owner-bound-source-interleaved",
          ] as const)
        : (["unchanged", "cancelled", "failed"] as const);
    it.each(authorizationOutcomes)(
      `enforces %s task authorization across ${boundary}`,
      async (outcome) => {
        const queued = boundary.startsWith("queued");
        const unchanged = outcome.endsWith("unchanged");
        await withAdminIngress(async ({ state, cfg, admins, context }) => {
          const recover = () =>
            drainPendingDeliveriesCore({
              drainKey: "matrix:completion-custody",
              logLabel: "Completion custody",
              cfg,
              log: createRecoveryLog(),
              stateDir: state.stateDir,
              deliver: deliverOutboundPayloads,
              selectEntry: () => ({ match: true, bypassBackoff: true }),
            });
          resetTaskRegistryForTests();
          const key = "agent:main:matrix:direct:owner";
          const child = "codex-thread:final-send-child";
          const source = "announce:final-send-child:succeeded";
          const recovery = "restart-recovery:final-send";
          const runtime = createAgentHarnessTaskRuntime({
            runtime: "subagent",
            taskKind: "codex-native-subagent",
            scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: key }),
            runIdPrefix: "codex-thread:",
          });
          const task = runtime.createRunningTaskRun({
            runId: child,
            sourceId: child,
            task: "Produce a result for the final-send custody check",
            requesterAgentId: "main",
            notifyPolicy: "silent",
          });
          runtime.finalizeTaskRunByRunId({
            runId: child,
            status: "succeeded",
            endedAt: Date.now(),
            terminalSummary: "child result",
          });
          runtime.setDetachedTaskDeliveryStatusByRunId({ runId: child, deliveryStatus: "pending" });
          const target = {
            agentId: "main",
            sessionKey: key,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
          };
          const entry = {
            sessionId: "original-parent",
            lifecycleRevision: "original-revision",
            status: "running" as const,
            updatedAt: Date.now(),
            restartRecoveryDeliveryRunId: recovery,
          };
          await replaceSessionEntry(target, entry);
          const provenance = {
            kind: "inter_session",
            sourceTool: "agent_harness_task",
            sourceChannel: "internal",
            sourceSessionKey: child,
          };
          const claim = captureHarnessCompletionRecovery({
            agentId: "main",
            sessionKey: key,
            entry,
            runId: source,
            inputProvenance: provenance,
          });
          if (!claim) {
            throw new Error("completion claim was not admitted");
          }
          await appendTranscriptMessage(
            { ...target, sessionId: entry.sessionId },
            {
              message: {
                role: "user",
                content: "child result",
                idempotencyKey: `${source}:user`,
                provenance,
                __openclaw: { runId: source },
                timestamp: Date.now(),
              },
            },
          );
          const admittedEntry = { ...entry, restartRecoveryHarnessCompletion: claim };
          await replaceSessionEntry(target, admittedEntry);
          const opts = bindCommandHarnessCompletionAssertion({
            claim,
            persisted: admittedEntry,
            sessionKey: key,
            storePath: target.storePath,
            opts: {
              message: "Continue admitted completion",
              assertSourceCurrent: outcome.startsWith("owner-bound")
                ? captureCommandOwnerAssertion(await context(admins[0]!.identity.senderId))
                : undefined,
            },
          });
          const assertCurrent = opts.assertSourceCurrent!;
          if (outcome.startsWith("owner-bound")) {
            expect(assertCurrent.recoveryReference).toBeTruthy();
          }
          const payloads = [{ text: "The completed child result" }];
          const marker = await persistPendingFinalDeliveryMarker({
            agentId: target.agentId,
            deliver: true,
            sessionStore: { [key]: admittedEntry },
            sessionKey: key,
            sessionEntry: admittedEntry,
            storePath: target.storePath,
            suppressVisibleSessionEffects: false,
            sessionReboundDuringRun: false,
            payloads,
            deliveryContext: { channel: "matrix", to: "!owner:example", accountId: "default" },
            runOwnedSessionId: entry.sessionId,
            commandOwnerReference: assertCurrent.recoveryReference,
          });
          expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
          assertCurrent();
          const entered = createDeferred();
          const release = createDeferred();
          const writes: string[] = [];
          const controller = new AbortController();
          let recoveryStarted = false;
          const hold = async () => {
            entered.resolve();
            await release.promise;
          };
          let prepareAttempts = 0;
          const plugin: ChannelPlugin = {
            ...createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => {
                  throw new Error("message adapter must own the send");
                },
              },
            }),
            message: {
              id: "matrix",
              durableFinal: { capabilities: { text: true } },
              send: {
                lifecycle: {
                  beforeSendAttempt: async () => {
                    if (boundary === "adapter preparation") {
                      await hold();
                    } else if (queued && prepareAttempts++ === 0) {
                      throw new PlatformMessageNotDispatchedError("temporary transport failure", {
                        cause: undefined,
                      });
                    }
                  },
                },
                text: async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
                  if (handoff && !recoveryStarted && boundary.endsWith("onPlatformSendDispatch")) {
                    await hold();
                  }
                  await onPlatformSendDispatch?.();
                  if (
                    handoff &&
                    !recoveryStarted &&
                    boundary.endsWith("assertDirectAdapterHandoff")
                  ) {
                    await hold();
                  }
                  assertDirectAdapterHandoff?.();
                  writes.push(text);
                  return {
                    messageId: "recorded-final",
                    receipt: createMessageReceiptFromOutboundResults({
                      results: [{ channel: "matrix", messageId: "recorded-final" }],
                      kind: "text",
                    }),
                  };
                },
              },
            },
          };
          const registry = createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]);
          if (boundary === "reply hook") {
            addTestHook({
              registry,
              pluginId: "held-completion-hook",
              hookName: "reply_payload_sending",
              handler: hold,
            });
          }
          setActivePluginRegistry(registry);
          initializeGlobalHookRunner(registry);
          const delivery = deliverAgentCommandResult({
            cfg,
            deps: {},
            runtime: { log: () => {}, error: () => {}, exit: () => {} },
            opts: {
              ...opts,
              abortSignal: controller.signal,
              deliver: true,
              replyChannel: "matrix",
              replyTo: "!owner:example",
              accountId: "default",
              sessionKey: key,
              runId: recovery,
            },
            outboundSession: { agentId: "main", key },
            sessionEntry: marker.sessionEntry,
            result: { meta: { durationMs: 1 } },
            payloads,
            assertDeliveryCurrent: () => {
              assertCurrent();
              controller.signal.throwIfAborted();
            },
          }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          if (queued) {
            expect((await delivery).ok).toBe(false);
            const pending = await loadPendingDeliveries(state.stateDir);
            expect(pending).toHaveLength(1);
            expect(pending[0]?.deliveryCompletion).toMatchObject({
              kind: "pending-final",
              sessionWriterDeliveryAuthority: { harnessCompletion: claim },
            });
          } else {
            await entered.promise;
          }
          expect(writes).toEqual([]);
          if (readFailure) {
            expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(1);
            const sourceRead = vi
              .spyOn(transcriptReads, "everySessionTranscriptUserInputFrom")
              .mockImplementationOnce(() => {
                throw new Error("Source transcript read unavailable");
              });
            release.resolve();
            try {
              expect((await delivery).ok).toBe(false);
            } finally {
              sourceRead.mockRestore();
            }
          }
          if (outcome.endsWith("source-interleaved")) {
            await appendTranscriptMessage(
              { ...target, sessionId: entry.sessionId },
              { message: { role: "user", content: "A new request", timestamp: Date.now() } },
            );
            expect(assertCurrent).toThrow(SessionWorkStartChangedError);
          } else if (outcome === "cancelled" || outcome === "failed") {
            markTaskTerminalById({ taskId: task.taskId, status: outcome, endedAt: Date.now() + 1 });
            expect(getTaskById(task.taskId)?.status).toBe(outcome);
            expect(assertCurrent).toThrow();
          }
          if (boundary === "queued after cleanup") {
            await appendTranscriptMessage(
              { ...target, sessionId: entry.sessionId },
              {
                message: {
                  role: "user",
                  content: "Continue the admitted completion",
                  idempotencyKey: `${recovery}:user`,
                  provenance: {
                    kind: "internal_system",
                    sourceTool: "main_session_restart_recovery",
                    sourceSessionKey: key,
                  },
                  __openclaw: { runId: recovery },
                  timestamp: Date.now(),
                },
              },
            );
            const markerEntry = marker.sessionEntry;
            if (!markerEntry) {
              throw new Error("pending final marker missing");
            }
            await replaceSessionEntry(target, {
              ...markerEntry,
              ...buildRestartRecoveryClaimCleanupPatch({
                entry: markerEntry,
                recordTerminalSource: true,
                terminalRunId: recovery,
                terminalSourceRunId: source,
              }),
            });
          }
          if (handoff) {
            if (restart) {
              controller.abort(createAgentRunRestartAbortError());
              release.resolve();
              expect((await delivery).ok).toBe(false);
            }
            recoveryStarted = true;
            await recover();
          } else if (queued) {
            // The drain reconstructs callbacks from SQLite, not the old sender closure.
            await recover();
          } else {
            release.resolve();
            const settled = await delivery;
            if (boundary === "reply hook" && !unchanged) {
              // Revocation before queue admission retires the unsent intent.
              expect(settled.ok).toBe(true);
              if (!settled.ok) {
                throw settled.error;
              }
              expect(settled.value.deliveryStatus).toMatchObject({
                status: "suppressed",
                reason: "no_visible_result",
                resultCount: 0,
              });
            } else {
              expect(settled.ok).toBe(unchanged);
            }
          }
          expect(writes).toEqual(unchanged ? ["The completed child result"] : []);
          // Revocation must not leave a queued stale reply for a later drain.
          expect(await loadPendingDeliveries(state.stateDir)).toEqual([]);
          if (handoff) {
            await recover();
            expect(writes).toEqual(unchanged ? ["The completed child result"] : []);
          }
          expect(getTaskById(task.taskId)?.deliveryStatus).toBe(
            unchanged ? "delivered" : "pending",
          );
          if (unchanged) {
            // Reopen task state as startup would: queue acknowledgment must not
            // be the only copy of the exact harness completion receipt.
            resetTaskRegistryForTests({ persist: false });
            expect(
              reconcileHarnessCompletionDelivery({
                ...target,
                sourceRunId: source,
                taskRunId: child,
              }),
            ).toBe("delivered");
            expect(getTaskById(task.taskId)?.deliveryStatus).toBe("delivered");
          }
        });
      },
    );
  }
});

describe("message-tool source reply custody", () => {
  it.each([
    {
      name: "confirmed source reply",
      result: { didDeliverSourceReplyViaMessageTool: true },
      expected: "delivered",
    },
    {
      name: "current-source receipt",
      result: { sourceReplyDelivered: true },
      expected: "delivered",
    },
    {
      name: "source final payload",
      result: {
        messagingToolSourceReplyPayloads: [{ text: "Done", sourceReplyFinal: true }],
      },
      expected: "delivered",
    },
    {
      name: "source progress without a final",
      result: {
        sourceReplyDelivered: true,
        messagingToolSourceReplyPayloads: [{ text: "Working", sourceReplyFinal: false }],
      },
      expected: "missing",
    },
    {
      name: "pending source delivery",
      result: { sourceReplyDeliveryState: "pending" },
      expected: "pending",
    },
    {
      name: "an unrelated outbound send",
      result: { didSendViaMessagingTool: true, messagingToolSentTexts: ["Elsewhere"] },
      expected: "missing",
    },
  ] satisfies Array<{ name: string; result: Partial<EmbeddedAgentRunResult>; expected: string }>)(
    "preserves reply satisfaction for $name when automatic delivery is disabled",
    async ({ result, expected }) => {
      setActivePluginRegistry(createTestRegistry());
      const delivered = await deliverAgentCommandResult({
        cfg: {},
        deps: {},
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
        opts: { message: "Private completion", deliver: false },
        outboundSession: undefined,
        sessionEntry: undefined,
        payloads: [],
        result: { meta: { durationMs: 1 }, ...result },
      });

      expect(resolveSourceReplyDelivery(delivered)).toBe(expected);
    },
  );
});
