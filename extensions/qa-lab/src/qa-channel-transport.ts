import type { QaBusState } from "./bus-state.js";
import { getQaProvider } from "./providers/index.js";
import {
  createQaTransportStateMethods,
  waitForQaTransportAccountReady,
  waitForQaTransportCondition,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";
import type {
  QaTransportAdapter,
  QaTransportGatewayConfig,
  QaTransportNativeCommandInput,
  QaTransportOutboundSequenceMatch,
  QaTransportPolicy,
  QaTransportReportParams,
} from "./qa-transport.js";

const QA_CHANNEL_ID = "qa-channel";
const QA_CHANNEL_ACCOUNT_ID = "default";
export const QA_CHANNEL_REQUIRED_PLUGIN_IDS = Object.freeze([QA_CHANNEL_ID]);
export const QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY = 4;

export function createQaChannelGatewayConfig(params: {
  baseUrl: string;
  transportPolicy?: QaTransportPolicy;
}): QaTransportGatewayConfig {
  const senderAllowlist = params.transportPolicy?.senderAllowlist;
  return {
    channels: {
      [QA_CHANNEL_ID]: {
        enabled: true,
        baseUrl: params.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: senderAllowlist ? [...senderAllowlist] : ["*"],
        ...(senderAllowlist
          ? {
              groupPolicy: "allowlist" as const,
              groupAllowFrom: [...senderAllowlist],
            }
          : {}),
        ...(params.transportPolicy?.requireGroupMention
          ? {
              groups: {
                "*": {
                  requireMention: true,
                },
              },
            }
          : {}),
        pollTimeoutMs: 250,
      },
    },
    messages: {
      visibleReplies: "automatic",
      groupChat: {
        mentionPatterns: ["\\b@?openclaw\\b"],
        visibleReplies: "automatic",
      },
    },
  };
}

function createQaChannelReportNotes(params: QaTransportReportParams) {
  const provider = getQaProvider(params.providerMode);
  return [
    provider.kind === "mock"
      ? `Runs against qa-channel + qa-lab bus + real gateway child + ${params.providerMode} provider.`
      : `Runs against qa-channel + qa-lab bus + real gateway child + live frontier models (${params.primaryModel}, ${params.alternateModel})${params.fastMode ? " with fast mode enabled" : ""}.`,
    params.isolatedWorkers === true
      ? `Scenarios run in isolated gateway workers with concurrency ${params.concurrency}.`
      : "Scenarios run serially in one gateway worker.",
    "Scheduling scenarios verify stored schedules and execution behavior through the Gateway.",
  ];
}

async function handleQaChannelAction(params: Parameters<QaTransportAdapter["handleAction"]>[0]) {
  const { qaChannelPlugin } = await import("openclaw/plugin-sdk/qa-channel");
  return await qaChannelPlugin.actions?.handleAction?.({
    channel: QA_CHANNEL_ID,
    action: params.action,
    cfg: params.cfg,
    accountId: params.accountId?.trim() || QA_CHANNEL_ACCOUNT_ID,
    params: params.args,
  });
}

export function createQaChannelTransport(state: QaBusState, transportPolicy?: QaTransportPolicy) {
  const methods = createQaTransportStateMethods({ state, accountId: QA_CHANNEL_ACCOUNT_ID });
  return {
    ...methods,
    id: QA_CHANNEL_ID,
    label: "qa-channel + qa-lab bus",
    accountId: QA_CHANNEL_ACCOUNT_ID,
    requiredPluginIds: QA_CHANNEL_REQUIRED_PLUGIN_IDS,
    supportedActions: ["delete", "edit", "react", "thread-create"],
    async reset() {
      await waitForQaTransportCondition(() => {
        if (
          state
            .getSnapshot()
            .events.some(
              (event) =>
                event.kind === "inbound-message" &&
                state.getAcknowledgedPollCursor(event.accountId) < event.cursor,
            )
        ) {
          return undefined;
        }
        // Reset clears every account. Check and clear together so a newly admitted
        // turn cannot lose its message while an earlier turn is being drained.
        state.reset();
        return true;
      });
    },
    createGatewayConfig: ({ baseUrl }) =>
      createQaChannelGatewayConfig({ baseUrl, transportPolicy }),
    waitReady: (params) =>
      waitForQaTransportAccountReady({
        ...params,
        accountId: QA_CHANNEL_ACCOUNT_ID,
        channel: QA_CHANNEL_ID,
      }),
    buildAgentDelivery: ({ target, threadId }) => ({
      channel: QA_CHANNEL_ID,
      replyChannel: QA_CHANNEL_ID,
      replyTo: target,
      ...(threadId ? { threadId } : {}),
    }),
    async sendNativeCommand(input: QaTransportNativeCommandInput): Promise<void> {
      const { command, ...message } = input;
      await methods.sendInbound({
        ...message,
        text: `/${command}`,
        nativeCommand: { name: command.split(/\s+/u, 1)[0] ?? command },
      });
    },
    async waitForOutboundSequence(input: QaTransportOutboundSequenceMatch) {
      return await waitForQaTransportOutboundSequence({
        accountId: QA_CHANNEL_ACCOUNT_ID,
        input,
        readEvents: () => state.getSnapshot().events,
      });
    },
    handleAction: handleQaChannelAction,
    createReportNotes: createQaChannelReportNotes,
  } satisfies QaTransportAdapter;
}
