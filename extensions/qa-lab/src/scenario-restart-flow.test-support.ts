import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

type RestartFlowFault = "none" | "duplicate resume" | "duplicate delivery";

/** Exercises the loaded orchestration, not Gateway shutdown or resume admission. */
export function createRestartFlowFixture(fault: RestartFlowFault = "none") {
  const state = createQaBusState();
  const events: string[] = [];
  const restartOrigins: unknown[] = [];
  const sessionKey = "agent:qa:restart-flow";
  let restarts = 0;
  let conversationId = "";
  const delivery = () =>
    state.addOutboundMessage({
      accountId: "default",
      to: `dm:${conversationId}`,
      text: "RESTART-CODE-MODE-WAIT-OK",
    });
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
        env: { cfg: { session: {} } },
        transport: {
          accountId: "default",
          sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) => {
            conversationId = input.conversation.id;
            events.push("inbound");
            return state.addInboundMessage(input);
          },
          waitForNoOutbound: async (options: { quietMs: number; sinceIndex: number }) => {
            events.push(`quiet:${options.quietMs}:${options.sinceIndex}`);
          },
        },
        buildAgentSessionKey: () => sessionKey,
        markGatewayLogCursor: () => 0,
        assertNoGatewayLogSentinels: () => undefined,
        readSessionTranscriptSummary: async (
          _env: unknown,
          _sessionKey: string,
          options?: { afterEventCursor?: number; pendingCodeModeExecNeedle?: string },
        ) => {
          if (options?.pendingCodeModeExecNeedle) {
            events.push(`pending:${options.pendingCodeModeExecNeedle}`);
            return {
              hasPendingCodeModeWait: true,
              userMessageCount: restarts + 1,
              eventCursor: restarts * 10 + 5,
              probeTextEndLine: 1,
            };
          }
          if (options?.afterEventCursor !== undefined) {
            events.push(`resume:${restarts}`);
            return {
              userMessageCount: fault === "duplicate resume" ? 2 : 1,
              eventCursor: restarts * 10 + 1,
              probeTextEndLine: restarts * 10 + 1,
            };
          }
          return {
            assistantToolCallCounts: { exec: 3, wait: 3 },
            lastAssistantStopReason: "stop",
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
  return { run, events, restartOrigins };
}
