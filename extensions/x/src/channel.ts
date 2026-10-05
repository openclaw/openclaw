import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { buildChannelConfigSchema, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { buildOpenGroupPolicyWarning } from "openclaw/plugin-sdk/channel-policy";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import {
  listXAccountIds,
  resolveXAccount,
  resolveDefaultXAccountId,
  type ResolvedXAccount,
} from "./accounts.js";
import { normalizeXUserId } from "./allowlist.js";
import { XConfigSchema } from "./config-schema.js";
import { channelSecrets } from "./secret-contract.js";
import type { sendXDelivery } from "./send.js";
import { normalizeXReplyTarget } from "./target.js";

const send = async (params: Parameters<typeof sendXDelivery>[0]) =>
  (await import("./send.js")).sendXDelivery(params);
const message = defineChannelMessageAdapter({ id: "x", send: { text: send } });

export const xPlugin: ChannelPlugin<ResolvedXAccount> = {
  id: "x",
  meta: {
    id: "x",
    label: "X (Twitter)",
    selectionLabel: "X (Twitter mentions)",
    docsPath: "/channels/x",
    docsLabel: "x",
    blurb: "Allowlisted mentions with thread context and public replies.",
    order: 85,
  },
  capabilities: {
    chatTypes: ["group"],
    media: false,
    reactions: false,
    threads: true,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.x"] },
  configSchema: buildChannelConfigSchema(XConfigSchema),
  config: {
    listAccountIds: listXAccountIds,
    defaultAccountId: resolveDefaultXAccountId,
    resolveAccount: resolveXAccount,
    inspectAccount: (cfg, accountId) => {
      const account = resolveXAccount(cfg, accountId);
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        name: account.name,
      };
    },
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      dmPolicy: "disabled",
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveXAccount(cfg, accountId).config.allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.flatMap((entry) => normalizeXUserId(String(entry)) ?? []),
  },
  secrets: channelSecrets,
  groups: { resolveRequireMention: () => true },
  security: {
    collectWarnings: ({ account }) =>
      account.config.groupPolicy === "open"
        ? [
            buildOpenGroupPolicyWarning({
              surface: "X public replies",
              openBehavior: "any account that mentions the bot can trigger a public reply",
              remediation:
                'Set channels.x.groupPolicy="allowlist" and add trusted numeric user IDs.',
            }),
          ]
        : [],
  },
  messaging: {
    targetPrefixes: ["x"],
    normalizeTarget: normalizeXReplyTarget,
    inferTargetChatType: () => "group",
    targetResolver: {
      looksLikeId: (value) => Boolean(normalizeXReplyTarget(value)),
      hint: "x:<postId> or https://x.com/<handle>/status/<postId>",
    },
  },
  threading: { resolveReplyToMode: createStaticReplyToModeResolver("all") },
  actions: {
    describeMessageTool: ({ cfg, accountId }) =>
      (accountId
        ? [resolveXAccount(cfg, accountId)]
        : listXAccountIds(cfg).map((id) => resolveXAccount(cfg, id))
      ).some((account) => account.enabled && account.configured)
        ? { actions: ["send"], capabilities: [] }
        : null,
    supportsAction: ({ action }) => action === "send",
    extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
    handleAction: async ({ action, params, cfg, accountId, assertDirectAdapterHandoff }) => {
      if (action !== "send") {
        throw new Error(`X does not support ${action}.`);
      }
      const result = await send({
        cfg,
        accountId,
        to: readStringParam(params, "to", { required: true }),
        text: readStringParam(params, "message", { required: true }),
        mediaUrl: readStringParam(params, "media"),
        assertDirectAdapterHandoff,
      });
      return jsonResult({ ok: true, messageId: result.messageId });
    },
  },
  message,
  outbound: {
    deliveryMode: "direct",
    sendText: send,
    sendMedia: async () => {
      throw new Error("X supports text replies only; media is not supported.");
    },
    // The native sender chunks the complete payload once, preserving its reply chain and signature.
    sendPayload: async (ctx) => {
      const result = await send({
        ...ctx,
        text: ctx.payload.text ?? "",
        mediaUrl: ctx.payload.mediaUrl,
        mediaUrls: ctx.payload.mediaUrls,
      });
      await ctx.onDeliveryResult?.(result);
      return result;
    },
  },
  status: {
    defaultRuntime: { accountId: "default", running: false },
    buildChannelSummary: ({ snapshot }) => ({ ...snapshot }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      dmPolicy: "disabled",
    }),
  },
  gateway: { startAccount: async (ctx) => (await import("./monitor.js")).startXAccount(ctx) },
};
