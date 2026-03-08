import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { ResolvedEmailAccount } from "./types.js";
import {
  listEmailAccountIds,
  resolveDefaultEmailAccountId,
  resolveEmailAccount,
} from "./accounts.js";
import { sendEmailOutbound } from "./send.js";

const meta = getChatChannelMeta("email" as never);

export const emailPlugin: ChannelPlugin<ResolvedEmailAccount> = {
  id: "email" as never,
  meta: {
    ...meta,
    id: "email" as never,
    label: "Email",
    icon: "email",
    showConfigured: false,
    quickstartAllowFrom: false,
    forceAccountBinding: false,
    preferSessionLookupForAnnounceTarget: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.email"] },
  gatewayMethods: ["email.inbound"],
  config: {
    listAccountIds: (cfg) => listEmailAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveEmailAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultEmailAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const channels = cfg.channels as Record<string, unknown> ?? {};
      const emailSection = channels.email as Record<string, unknown> ?? {};
      const accounts = (emailSection.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          email: {
            ...emailSection,
            accounts: {
              ...accounts,
              [accountKey]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      } as typeof cfg;
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const channels = cfg.channels as Record<string, unknown> ?? {};
      const emailSection = { ...(channels.email as Record<string, unknown> ?? {}) };
      const accounts = { ...((emailSection.accounts ?? {}) as Record<string, unknown>) };
      delete accounts[accountKey];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          email: {
            ...emailSection,
            accounts: Object.keys(accounts).length ? accounts : undefined,
          },
        },
      } as typeof cfg;
    },
    isEnabled: (account) => account.enabled,
    disabledReason: () => "disabled",
    isConfigured: (account) => Boolean(account.address && account.outboundUrl && account.outboundToken),
    unconfiguredReason: () => "not configured",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.address && account.outboundUrl && account.outboundToken),
      address: account.address,
      dmPolicy: account.dmPolicy,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveEmailAccount({ cfg, accountId }).allowFrom?.map((e) => String(e)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy ?? "open",
      allowFrom: account.allowFrom ?? [],
      policyPath: `channels.email.accounts.${account.accountId}.dmPolicy`,
      allowFromPath: `channels.email.accounts.${account.accountId}.`,
      approveHint: "Add the sender email to channels.email.allowFrom",
      normalizeEntry: (raw: string) => raw.toLowerCase().trim(),
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 50000,
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed && trimmed.includes("@")) {
        return { ok: true, to: trimmed };
      }
      const firstAllow = (allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .find((entry) => {
          const candidate = entry.toLowerCase();
          return candidate.includes("@") && !candidate.startsWith("*@");
        });
      if (firstAllow) {
        return { ok: true, to: firstAllow };
      }
      return {
        ok: false,
        error: new Error(
          "Email target required: provide an email address or configure channels.email.allowFrom",
        ),
      };
    },
    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const account = resolveEmailAccount({ cfg, accountId });
      const subject = "Message from OpenClaw";
      const result = await sendEmailOutbound({
        account,
        payload: {
          to,
          subject,
          text,
          ...(replyToId ? { inReplyTo: String(replyToId) } : {}),
        },
      });

      return {
        channel: "email",
        messageId: result.messageId ?? `email-${Date.now()}`,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, replyToId }) => {
      const account = resolveEmailAccount({ cfg, accountId });
      const subject = "Message from OpenClaw";
      const composedText = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendEmailOutbound({
        account,
        payload: {
          to,
          subject,
          text: composedText,
          ...(replyToId ? { inReplyTo: String(replyToId) } : {}),
        },
      });

      return {
        channel: "email",
        messageId: result.messageId ?? `email-${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      ctx.log?.info(
        `[${ctx.accountId}] email channel ready (${ctx.account.address})`,
      );
    },
  },
};
