import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type {
  DailyflowsChannelPlugin,
  DailyflowsOutboundContext,
  DailyflowsOutboundResult,
} from "./types.js";
import { listDailyflowsAccountIds, resolveDailyflowsAccount } from "./config.js";
import { sendDailyflowsMessage } from "./send.js";

const meta = {
  id: "dailyflows",
  label: "Dailyflows",
  selectionLabel: "Dailyflows (Webhook)",
  detailLabel: "Dailyflows",
  docsPath: "/channels/dailyflows",
  docsLabel: "dailyflows",
  blurb: "Dailyflows webhook channel.",
  systemImage: "message.fill",
};

export const dailyflowsPlugin: DailyflowsChannelPlugin = {
  id: "dailyflows",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.dailyflows"] },
  config: {
    listAccountIds: (cfg) => listDailyflowsAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDailyflowsAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => Boolean(account.webhookSecret || account.outboundUrl),
    unconfiguredReason: () => "Set channels.dailyflows.accounts.<id>.outboundUrl or webhookSecret",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.webhookSecret || account.outboundUrl),
      meta: {
        outboundUrl: account.outboundUrl ?? null,
      },
    }),
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Dailyflows target required. Provide a conversationId or senderId."),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async (params: DailyflowsOutboundContext): Promise<DailyflowsOutboundResult> => {
      const { cfg, to, text, accountId } = params;
      return sendDailyflowsMessage({
        cfg,
        payload: {
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
          conversationId: to,
          text,
        },
      });
    },
    sendMedia: async (params: DailyflowsOutboundContext): Promise<DailyflowsOutboundResult> => {
      const { cfg, to, text, mediaUrl, accountId } = params;
      return sendDailyflowsMessage({
        cfg,
        payload: {
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
          conversationId: to,
          text: text?.trim() ? text : undefined,
          attachments: mediaUrl ? [{ type: "file", url: mediaUrl }] : undefined,
        },
      });
    },
  },
};
