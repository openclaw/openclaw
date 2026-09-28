import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import { buildToolLifecycleErrorResult } from "../../embedded-agent-tool-results.js";

type SubscriptionMock = ReturnType<
  typeof import("../../embedded-agent-subscribe.js").subscribeEmbeddedAgentSession
>;

export function createSubscriptionMock(): SubscriptionMock {
  // Minimal subscription surface for runEmbeddedAttempt tests; individual tests
  // override only the lifecycle method they need.
  return {
    assistantTexts: [] as string[],
    answerSegments: [] as SubscriptionMock["answerSegments"],
    getCurrentAttemptAssistant: () => undefined,
    hasSuccessfulModelResponse: () => false,
    getLastAssistantTextMessageIndex: () => undefined,
    getLatestMcpAppChannelView: () => undefined,
    getLatestMcpConnectAction: () => undefined,
    toolMetas: [] as SubscriptionMock["toolMetas"],
    runToolLifecycle: async <T>(toolParams: {
      args: unknown;
      replaySafe?: boolean;
      execute: (onImplementationStart: () => void) => Promise<T>;
      onTerminal?: (terminal: {
        result: unknown;
        isError: boolean;
        executedArguments: unknown;
        effectReceipt: {
          state: "read_completed" | "failed_no_effect" | "mutation_committed" | "uncertain";
        };
      }) => void | Promise<void>;
    }) => {
      try {
        const result = await toolParams.execute(() => undefined);
        await toolParams.onTerminal?.({
          result,
          isError: false,
          executedArguments: structuredClone(toolParams.args),
          effectReceipt: {
            state: toolParams.replaySafe ? "read_completed" : "mutation_committed",
          },
        });
        return result;
      } catch (error) {
        await toolParams.onTerminal?.({
          result: buildToolLifecycleErrorResult(error),
          isError: true,
          executedArguments: structuredClone(toolParams.args),
          effectReceipt: {
            state: toolParams.replaySafe ? "failed_no_effect" : "uncertain",
          },
        });
        throw error;
      }
    },
    unsubscribe: () => {},
    setTerminalLifecycleMeta: () => {},
    waitForCompactionRetry: async () => {},
    waitForPendingEvents: async () => {},
    flushPartialAssistantText: () => {},
    getAcceptedSessionSpawns: () => [],
    getMessagingToolSentTexts: () => [] as string[],
    getMessagingToolSentMediaUrls: () => [] as string[],
    getMessagingToolSentTargets: () => [] as MessagingToolSend[],
    getMessagingToolSourceReplyPayloads: () => [] as MessagingToolSourceReplyPayload[],
    getSourceReplyDelivered: () => undefined,
    getSourceReplyDeliveryState: () => undefined,
    getHeartbeatToolResponse: () => undefined,
    getPendingToolMediaReply: () => null,
    getToolAutoDeliveryMediaUrls: () => [] as string[],
    hasToolMediaBlockReply: () => false,
    getVisibleBlockReplyCount: () => 0,
    getSuccessfulCronAdds: () => 0,
    getReplayState: () => ({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    }),
    didSendViaMessagingTool: () => false,
    didSendDeterministicApprovalPrompt: () => false,
    getLastToolError: () => undefined,
    getUsageTotals: () => undefined,
    getLastAssistantUsage: () => undefined,
    getAssistantTurnCount: () => 0,
    getCompactionCount: () => 0,
    getLastCompactionTokensAfter: () => undefined,
    getItemLifecycle: () => ({ startedCount: 0, completedCount: 0, activeCount: 0 }),
    isCompacting: () => false,
    isCompactionInFlight: () => false,
  };
}
