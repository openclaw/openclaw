import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

type RestartFlowFault =
  | "none"
  | "missing delivery claim"
  | "stale lifecycle"
  | "stale delivery owner"
  | "changed audit identity"
  | "duplicate delivery"
  | "extra inbound"
  | "late delivery";

/** Exercises the loaded orchestration, not a Gateway or managed-update process. */
export function createRestartFlowFixture(fault: RestartFlowFault = "none") {
  const state = createQaBusState();
  const events: string[] = [];
  const auditRunIds: string[] = [];
  const restartOrigins: unknown[] = [];
  const sessionKey = "agent:qa:restart-flow";
  let restarts = 0;
  let conversationId = "";
  const delivery = () => {
    state.addOutboundMessage({
      accountId: "default",
      to: `dm:${conversationId}`,
      text: "unsafeVisible=false\nRESTART-CODE-MODE-WAIT-OK",
    });
  };
  const run = () =>
    runLoadedScenarioFlow("gateway-restart-inflight-run", {
      state,
      onWaitForOutboundMessage: () => {
        events.push("delivery");
        delivery();
        if (fault === "duplicate delivery") {
          delivery();
        }
      },
      api: {
        env: { cfg: { session: {} }, mock: { baseUrl: "http://mock.invalid" } },
        transport: {
          accountId: "default",
          sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) => {
            conversationId = input.conversation.id;
            events.push("inbound");
            const inbound = state.addInboundMessage(input);
            if (fault === "extra inbound") {
              state.addInboundMessage(input);
            }
            return inbound;
          },
          waitForNoOutbound: async (options: { quietMs: number; sinceIndex: number }) => {
            events.push(`quiet:${options.quietMs}:${options.sinceIndex}`);
            if (fault === "late delivery") {
              delivery();
              throw new Error("unexpected outbound during quiet window");
            }
          },
        },
        buildAgentSessionKey: () => sessionKey,
        markGatewayLogCursor: () => 0,
        readGatewayLogs: () =>
          "dispatching restart-safe recovery\nrestart-safe recovery tool policy retained\n".repeat(
            restarts,
          ),
        assertNoGatewayLogSentinels: () => undefined,
        recentOutboundSummary: () => "fixture deliveries",
        fetchJson: async (url: string) =>
          url.endsWith("request-cursor")
            ? { cursor: 0 }
            : Array.from({ length: Math.min(restarts + 1, 3) }, () => ({
                plannedToolName: "qa_restart_wait",
                plannedWireToolName: "exec",
              })),
        readSessionTranscriptSummary: async (
          _env: unknown,
          _sessionKey: string,
          options?: { pendingCodeModeExecNeedle?: string },
        ) => {
          if (options?.pendingCodeModeExecNeedle) {
            events.push(`pending:${options.pendingCodeModeExecNeedle}`);
          }
          return {
            hasPendingCodeModeWait: true,
            userMessageCount: 1,
            eventCursor: restarts + 1,
            probeTextEndLine: 1,
            assistantToolCallCounts: { exec: 3, wait: 3 },
            finalText: "RESTART-CODE-MODE-WAIT-OK",
            lastAssistantStopReason: "stop",
          };
        },
        readRawQaSessionStore: async () => {
          events.push(`persisted:${restarts + 1}`);
          const generation = fault === "stale lifecycle" && restarts === 2 ? 2 : restarts + 1;
          const runId =
            fault === "stale delivery owner" && restarts === 2
              ? "delivery-2"
              : `delivery-${restarts + 1}`;
          return {
            [sessionKey]: {
              restartRecoveryDeliveryContext:
                fault === "missing delivery claim"
                  ? undefined
                  : { channel: "qa-channel", to: `dm:${conversationId}` },
              restartRecoveryDeliveryRunId: runId,
              restartRecoveryRuns: [{ runId, lifecycleGeneration: generation }],
            },
          };
        },
        runQaCli: async (_env: unknown, args: string[]) => {
          const runId = args[2];
          if (!runId) {
            throw new Error("audit command omitted the run identity");
          }
          auditRunIds.push(runId);
          return {
            identity: {
              state: "present",
              context: {
                runId,
                contextId: "original-context",
                executionId:
                  fault === "changed audit identity" && restarts === 3
                    ? "replacement-execution"
                    : "original-execution",
              },
            },
          };
        },
        restartGatewayWithConfigPatch: async (input: {
          patch: { gateway: { controlUi: { allowedOrigins: string[] } } };
        }) => {
          restartOrigins.push(input.patch.gateway.controlUi.allowedOrigins);
          restarts += 1;
          events.push(`restart:${restarts}`);
        },
      },
    });
  return { run, events, auditRunIds, restartOrigins };
}
