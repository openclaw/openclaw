// Exercises the automatic sender with real task/session stores and recording transport.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainMatrixReconnect } from "../../infra/outbound/deliver.queue-integration.test-support.js";
import { loadPendingDeliveries } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createAgentHarnessTaskRuntime } from "../../plugin-sdk/agent-harness-task-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
} from "../../tasks/agent-harness-completion-recovery.js";
import { createAgentHarnessTaskRuntimeScope } from "../../tasks/agent-harness-task-runtime-scope.js";
import { getTaskById, markTaskTerminalById } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reconcileHarnessCompletionDelivery } from "../agent-harness-completion-delivery.js";
import { resolveSourceReplyDelivery } from "../embedded-agent-runner/delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
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
  ] as const) {
    it.each(["unchanged", "cancelled", "failed"] as const)(
      `enforces %s task authorization across ${boundary}`,
      async (outcome) => {
        const queued = boundary.startsWith("queued");
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
          });
          expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
          const assertCurrent = createHarnessCompletionSourceAssertion({
            claim,
            storePath: target.storePath,
          });
          assertCurrent();
          const entered = createDeferred();
          const release = createDeferred();
          const writes: string[] = [];
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
                  await onPlatformSendDispatch?.();
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
            cfg: {},
            deps: {},
            runtime: { log: () => {}, error: () => {}, exit: () => {} },
            opts: {
              message: "Continue admitted completion",
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
            assertDeliveryCurrent: assertCurrent,
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
          if (outcome !== "unchanged") {
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
          if (queued) {
            // The drain reconstructs callbacks from SQLite, not the old sender closure.
            await drainMatrixReconnect({
              stateDir: state.stateDir,
              deliver: deliverOutboundPayloads,
            });
          } else {
            release.resolve();
            const settled = await delivery;
            if (boundary === "reply hook" && outcome !== "unchanged") {
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
              expect(settled.ok).toBe(outcome === "unchanged");
            }
          }
          expect(writes).toEqual(outcome === "unchanged" ? ["The completed child result"] : []);
          // Revocation must not leave a queued stale reply for a later drain.
          expect(await loadPendingDeliveries(state.stateDir)).toEqual([]);
          expect(getTaskById(task.taskId)?.deliveryStatus).toBe(
            outcome === "unchanged" ? "delivered" : "pending",
          );
          if (outcome === "unchanged") {
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
