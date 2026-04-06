import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  listEmailAccountIds,
  resolveDefaultEmailAccountId,
  resolveEmailAccount,
  type ResolvedEmailAccount,
} from "./accounts.js";
import {
  buildBaseChannelStatusSummary,
  chunkTextForOutbound,
  createAccountStatusSink,
  type ChannelPlugin,
} from "./channel-api.js";
import { EmailChannelConfigSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";

const meta = {
  id: "email",
  label: "Email",
  selectionLabel: "Email (IMAP/SMTP)",
  docsPath: "/channels/email",
  docsLabel: "email",
  blurb: "IMAP polling inbound; SMTP replies; works with any standard mail server.",
  order: 90,
  detailLabel: "Email",
  systemImage: "envelope",
  markdownCapable: false,
};

type EmailChannelRuntimeModule = typeof import("./channel-runtime.js");

let emailChannelRuntimePromise: Promise<EmailChannelRuntimeModule> | undefined;

async function loadEmailChannelRuntime(): Promise<EmailChannelRuntimeModule> {
  emailChannelRuntimePromise ??= import("./channel-runtime.js");
  return await emailChannelRuntimePromise;
}

const emailConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedEmailAccount,
  ResolvedEmailAccount,
  CoreConfig
>({
  sectionKey: "email",
  listAccountIds: listEmailAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveEmailAccount),
  defaultAccountId: resolveDefaultEmailAccountId,
  clearBaseFields: [
    "imapHost",
    "imapPort",
    "imapUsername",
    "imapPassword",
    "imapPasswordFile",
    "smtpHost",
    "smtpPort",
    "smtpUsername",
    "smtpPassword",
    "smtpPasswordFile",
    "fromAddress",
  ],
  resolveAllowFrom: (account: ResolvedEmailAccount) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: (raw) => raw.trim().toLowerCase(),
    }),
  resolveDefaultTo: () => undefined,
});

const resolveEmailDmPolicy = createScopedDmSecurityResolver<ResolvedEmailAccount>({
  channelKey: "email",
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.trim().toLowerCase(),
});

const listEmailDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<ResolvedEmailAccount>({
  kind: "user",
  resolveAccount: adaptScopedAccountAccessor(resolveEmailAccount),
  resolveSources: (account) => [account.allowFrom ?? []],
  normalizeId: (entry) => entry.trim().toLowerCase() || null,
});

export const emailPlugin: ChannelPlugin<ResolvedEmailAccount, unknown> = createChatChannelPlugin({
  base: {
    id: "email",
    meta,
    setup: emailConfigAdapter as any,
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: ["channels.email"] },
    configSchema: EmailChannelConfigSchema,
    config: {
      ...emailConfigAdapter,
      hasConfiguredState: ({ env }) =>
        typeof env?.EMAIL_IMAP_HOST === "string" && env.EMAIL_IMAP_HOST.trim().length > 0,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            imapHost: account.imapHost,
            imapPort: account.imapPort,
            imapUsername: account.imapUsername,
            imapUseSsl: account.imapUseSsl,
            autoReplyEnabled: account.autoReplyEnabled,
            pollIntervalSeconds: account.pollIntervalSeconds,
          },
        }),
    },
    messaging: {
      normalizeTarget: (raw) => raw.trim().toLowerCase(),
      targetResolver: {
        looksLikeId: (id) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id),
        hint: "<email@example.com>",
      },
    },
    resolver: {
      resolveTargets: async ({ inputs }) =>
        inputs.map((input) => {
          const normalized = input.trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
            return { input, resolved: false, note: "invalid email address" };
          }
          return { input, resolved: true, id: normalized, name: normalized };
        }),
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listEmailDirectoryPeersFromConfig(params),
      listGroups: async () => [],
    }),
    status: createComputedAccountStatusAdapter<ResolvedEmailAccount, unknown>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ account, snapshot }) => ({
        ...buildBaseChannelStatusSummary(snapshot),
        imapHost: account.imapHost,
        imapPort: account.imapPort,
        imapUsername: account.imapUsername,
        autoReplyEnabled: account.autoReplyEnabled,
        pollIntervalSeconds: account.pollIntervalSeconds,
      }),
      probeAccount: async () => ({}),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          imapHost: account.imapHost,
          imapPort: account.imapPort,
          imapUsername: account.imapUsername,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        const statusSink = createAccountStatusSink({
          accountId: ctx.accountId,
          setStatus: ctx.setStatus,
        });
        if (!account.configured) {
          throw new Error(
            `Email is not configured for account "${account.accountId}" (need imapHost, imapUsername, imapPassword in channels.email).`,
          );
        }
        ctx.log?.info(
          `[${account.accountId}] starting email provider (${account.imapHost}:${account.imapPort})`,
        );
        const { monitorEmailProvider } = await loadEmailChannelRuntime();
        await runStoppablePassiveMonitor({
          abortSignal: ctx.abortSignal,
          start: async () =>
            await monitorEmailProvider({
              accountId: account.accountId,
              config: ctx.cfg as CoreConfig,
              runtime: ctx.runtime,
              abortSignal: ctx.abortSignal,
              statusSink,
            }),
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveEmailDmPolicy,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "text",
      textChunkLimit: 8000,
      sanitizeText: ({ text }) => sanitizeForPlainText(text),
    },
    attachedResults: {
      channel: "email",
      sendText: async ({ cfg, to, text, accountId }) => {
        const account = resolveEmailAccount({
          cfg: cfg as CoreConfig,
          accountId: accountId ?? null,
        });
        const { sendEmail } = await loadEmailChannelRuntime();
        await sendEmail({ account, to, text });
        return { messageId: `email:${Date.now()}:${Math.random().toString(36).slice(2)}` };
      },
    },
  },
});
