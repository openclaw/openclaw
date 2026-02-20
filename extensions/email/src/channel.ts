import {
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { EmailConfigSchema } from "./config-schema.js";
import { getEmailRuntime } from "./runtime.js";
import {
  normalizeEmailTarget,
  probeEmailAccount,
  sendMessageEmail,
  type ResolvedEmailAccount,
} from "./send.js";

function resolveEmailConfig(cfg: OpenClawConfig): {
  name?: string;
  enabled: boolean;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  from?: string;
  subjectPrefix?: string;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
} {
  const email = cfg.channels?.email;
  const smtpPassEnv =
    typeof email?.smtpPassEnv === "string" && email.smtpPassEnv.trim()
      ? process.env[email.smtpPassEnv.trim()]
      : undefined;
  return {
    name: email?.name,
    enabled: email?.enabled !== false,
    smtpHost: email?.smtpHost?.trim(),
    smtpPort: email?.smtpPort ?? 587,
    smtpSecure: email?.smtpSecure === true,
    smtpUser: email?.smtpUser?.trim(),
    smtpPass: email?.smtpPass?.trim() || smtpPassEnv,
    from: email?.from?.trim(),
    subjectPrefix: email?.subjectPrefix?.trim(),
    dmPolicy: email?.dmPolicy,
    allowFrom: email?.allowFrom,
  };
}

function resolveEmailAccount(cfg: OpenClawConfig): ResolvedEmailAccount {
  const config = resolveEmailConfig(cfg);
  const configured = Boolean(config.smtpHost && config.from);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: config.name,
    enabled: config.enabled,
    configured,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpSecure: config.smtpSecure,
    smtpUser: config.smtpUser,
    smtpPass: config.smtpPass,
    from: config.from,
    subjectPrefix: config.subjectPrefix,
    config: {
      dmPolicy: config.dmPolicy,
      allowFrom: config.allowFrom,
    },
  };
}

export const emailPlugin: ChannelPlugin<ResolvedEmailAccount> = {
  id: "email",
  meta: {
    id: "email",
    label: "Email",
    selectionLabel: "Email (SMTP)",
    detailLabel: "Email SMTP",
    docsPath: "/channels/email",
    docsLabel: "email",
    blurb: "SMTP outbound email channel for notifications and routing.",
    systemImage: "envelope",
    order: 70,
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  reload: { configPrefixes: ["channels.email"] },
  configSchema: buildChannelConfigSchema(EmailConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveEmailAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      lastError: null,
    }),
    resolveAllowFrom: ({ cfg }) =>
      (resolveEmailAccount(cfg).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "allowlist",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.email.dmPolicy",
      allowFromPath: "channels.email.allowFrom",
      approveHint: formatPairingApproveHint("email"),
      normalizeEntry: (raw) => normalizeEmailTarget(raw),
    }),
  },
  messaging: {
    normalizeTarget: (target) => normalizeEmailTarget(target),
    targetResolver: {
      looksLikeId: (input) => {
        try {
          normalizeEmailTarget(input);
          return true;
        } catch {
          return false;
        }
      },
      hint: "<user@example.com|email:user@example.com|mailto:user@example.com>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getEmailRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 8000,
    resolveTarget: ({ to }) => {
      try {
        return { ok: true, to: normalizeEmailTarget(to ?? "") };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    sendText: async ({ cfg, to, text }) => {
      const account = resolveEmailAccount(cfg);
      const result = await sendMessageEmail({ account, to, text });
      return {
        channel: "email",
        messageId: result.messageId,
        chatId: result.to,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl }) => {
      const account = resolveEmailAccount(cfg);
      const body = mediaUrl ? `${text}\n\nAttachment URL: ${mediaUrl}` : text;
      const result = await sendMessageEmail({ account, to, text: body });
      return {
        channel: "email",
        messageId: result.messageId,
        chatId: result.to,
      };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("email", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => await probeEmailAccount(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
};
