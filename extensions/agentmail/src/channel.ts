import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  inspectAgentMailAccount,
  isAgentMailAccountConfigured,
  listAgentMailAccountIds,
  resolveAgentMailAccount,
  resolveDefaultAgentMailAccountId,
} from "./accounts.js";
import { AgentMailChannelConfigSchema } from "./config-schema.js";
import { collectAgentMailStartupWarnings, startAgentMailGatewayAccount } from "./gateway.js";
import type { AgentMailChannelRuntime } from "./inbound.js";
import { normalizeMailbox } from "./mailbox.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import {
  normalizeAgentMailTarget,
  reconcileAgentMailUnknownSend,
  sendAgentMailReply,
} from "./send.js";
import { probeAgentMailAccount, type AgentMailProbe } from "./status.js";
import type { ResolvedAgentMailAccount } from "./types.js";

const CHANNEL_ID = "agentmail";

const configAdapter = createHybridChannelConfigAdapter<ResolvedAgentMailAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listAgentMailAccountIds,
  resolveAccount: resolveAgentMailAccount,
  defaultAccountId: resolveDefaultAgentMailAccountId,
  clearBaseFields: [
    "apiKey",
    "inboxId",
    "webhookSecret",
    "webhookPath",
    "dmPolicy",
    "allowFrom",
    "mediaMaxMb",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({ allowFrom, normalizeEntry: normalizeMailbox }),
});

const resolveDmPolicy = createScopedDmSecurityResolver<ResolvedAgentMailAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "allowlist",
  normalizeEntry: normalizeMailbox,
});

const collectSecurityWarnings = createConditionalWarningCollector<ResolvedAgentMailAccount>(
  (account) =>
    account.dmPolicy === "allowlist" && account.allowFrom.length === 0
      ? "- AgentMail: empty allowFrom denies every sender."
      : undefined,
  (account) =>
    account.dmPolicy === "open" && account.allowFrom.includes("*")
      ? '- AgentMail: dmPolicy="open" allows every sender.'
      : undefined,
);

const messageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      payload: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
      reconcileUnknownSend: true,
    },
    reconcileUnknownSendKinds: { text: true, media: true, payload: true },
    reconcileUnknownSend: reconcileAgentMailUnknownSend,
  },
  send: {
    mediaPayloadMode: "atomic",
    text: async (ctx) => await sendAgentMailReply(ctx),
    payload: async (ctx) => await sendAgentMailReply(ctx),
  },
});

export const agentMailPlugin: ChannelPlugin<ResolvedAgentMailAccount, AgentMailProbe> =
  createChatChannelPlugin({
    base: {
      id: CHANNEL_ID,
      meta: {
        id: CHANNEL_ID,
        label: "AgentMail",
        selectionLabel: "AgentMail (Email)",
        detailLabel: "AgentMail Email",
        docsPath: "/channels/agentmail",
        docsLabel: "agentmail",
        blurb: "Durable, allowlisted, reply-only email conversations through AgentMail.",
        order: 89,
      },
      capabilities: {
        chatTypes: ["direct"],
        media: true,
        threads: true,
        reactions: false,
        edit: false,
        unsend: false,
        reply: true,
        effects: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.agentmail"] },
      configSchema: AgentMailChannelConfigSchema,
      config: {
        ...configAdapter,
        inspectAccount: inspectAgentMailAccount,
        isConfigured: isAgentMailAccountConfigured,
        unconfiguredReason: () => "AgentMail requires apiKey and inboxId.",
        describeAccount: (account) => ({
          accountId: account.accountId,
          name: account.inboxId || "AgentMail",
          configured: isAgentMailAccountConfigured(account),
          enabled: account.enabled,
        }),
      },
      messaging: {
        targetPrefixes: ["message"],
        normalizeTarget: (raw) => normalizeAgentMailTarget(raw) ?? undefined,
        resolveOutboundSessionRoute: (params) => {
          const target = normalizeAgentMailTarget(params.resolvedTarget?.to ?? params.target);
          if (!target) {
            return null;
          }
          return buildChannelOutboundSessionRoute({
            cfg: params.cfg,
            agentId: params.agentId,
            channel: CHANNEL_ID,
            accountId: params.accountId,
            recipientSessionExact: true,
            peer: { kind: "direct", id: target },
            chatType: "direct",
            from: `agentmail:${target}`,
            to: target,
          });
        },
        targetResolver: {
          looksLikeId: (value) => normalizeAgentMailTarget(value) !== null,
          hint: "message:<messageId>",
        },
      },
      directory: createEmptyChannelDirectoryAdapter(),
      gateway: {
        startAccount: async (ctx) => {
          if (!ctx.channelRuntime) {
            ctx.log?.warn?.("AgentMail channel runtime is unavailable; ingress not started");
            return;
          }
          await startAgentMailGatewayAccount({
            cfg: ctx.cfg,
            account: ctx.account,
            channelRuntime: ctx.channelRuntime as unknown as AgentMailChannelRuntime,
            abortSignal: ctx.abortSignal,
            log: ctx.log,
          });
        },
      },
      status: {
        buildAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.inboxId || "AgentMail",
          enabled: account.enabled,
          configured: isAgentMailAccountConfigured(account),
          statusState: !account.enabled
            ? "disabled"
            : isAgentMailAccountConfigured(account)
              ? "configured"
              : "unconfigured",
        }),
        probeAccount: async ({ account }) => await probeAgentMailAccount({ account }),
        buildCapabilitiesDiagnostics: async ({ account }) => ({
          lines: collectAgentMailStartupWarnings(account).map((text) => ({ text, tone: "warn" })),
        }),
      },
      secrets: { secretTargetRegistryEntries, collectRuntimeConfigAssignments },
      agentPrompt: {
        messageToolHints: () => [
          "",
          "### AgentMail replies",
          "Reply only to the current email using its message:<messageId> target. You cannot address recipients or start a new email thread.",
        ],
      },
      message: messageAdapter,
    },
    security: {
      resolveDmPolicy,
      collectWarnings: ({ account }) => collectSecurityWarnings(account),
    },
    outbound: {
      deliveryMode: "gateway",
      extractMarkdownImages: true,
      resolveTarget: ({ to }) => {
        const target = normalizeAgentMailTarget(to);
        return target
          ? { ok: true, to: target }
          : {
              ok: false,
              error: new Error(
                "AgentMail target must be message:<messageId>; recipients and new threads are not supported.",
              ),
            };
      },
      sendText: async (ctx) => await sendAgentMailReply(ctx),
      sendPayload: async (ctx) => await sendAgentMailReply(ctx),
    },
  });
