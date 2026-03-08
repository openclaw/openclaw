import {
  applyAccountNameToChannelSection,
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { InstagramConfigSchema } from "./config-schema.js";
import {
  listInstagramAccountIds,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccount,
} from "./accounts.js";
import {
  listInstagramThreads,
  probeInstagram,
  resolveInstagramTargets,
  sendMessageInstagram,
} from "./client.js";
import { getInstagramRuntime } from "./runtime.js";
import { looksLikeInstagramTargetId, normalizeInstagramMessagingTarget, normalizeInstagramUsername } from "./normalize.js";
import { monitorInstagramProvider } from "./monitor.js";
import type { CoreConfig, InstagramProbe, ResolvedInstagramAccount } from "./types.js";

const meta = {
  id: "instagram",
  label: "Instagram",
  selectionLabel: "Instagram (plugin)",
  detailLabel: "Instagram CLI",
  docsPath: "/channels/instagram",
  docsLabel: "instagram",
  blurb: "routes Instagram DMs and group chats through instagram-cli LLM commands.",
  systemImage: "camera",
  order: 75,
  quickstartAllowFrom: true,
} as const;

function formatAllowEntry(entry: string): string {
  const username = normalizeInstagramUsername(entry);
  if (!username) {
    return "";
  }
  if (username === "*") {
    return "*";
  }
  return `@${username}`;
}

export const instagramPlugin: ChannelPlugin<ResolvedInstagramAccount, InstagramProbe> = {
  id: "instagram",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "instagramUser",
    normalizeAllowEntry: (entry) => normalizeInstagramUsername(entry),
    notifyApproval: async () => {},
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: true,
  },
  commands: {
    enforceOwnerForCommands: true,
    skipWhenConfigEmpty: true,
  },
  reload: { configPrefixes: ["channels.instagram"] },
  configSchema: buildChannelConfigSchema(InstagramConfigSchema),
  config: {
    listAccountIds: (cfg) => listInstagramAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveInstagramAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultInstagramAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "instagram",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "instagram",
        accountId,
        clearBaseFields: ["cliPath", "cwd", "sessionUsername", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      cliPath: account.cliPath,
      cwd: account.cwd,
      sessionUsername: account.sessionUsername,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveInstagramAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
    saveAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "instagram",
        accountId,
        name: input.name,
        alwaysUseAccounts: true,
      });
      const next = migrateBaseNameToDefaultAccount({
        cfg: namedConfig,
        channelKey: "instagram",
        alwaysUseAccounts: true,
      });
      const entry = {
        ...next.channels?.instagram?.accounts?.[accountId],
        ...(input.cliPath ? { cliPath: input.cliPath } : {}),
        enabled: true,
      };
      return {
        ...next,
        channels: {
          ...next.channels,
          instagram: {
            ...next.channels?.instagram,
            accounts: {
              ...next.channels?.instagram?.accounts,
              [accountId]: entry,
            },
          },
        },
      };
    },
  },
  security: {
    resolveDmPolicy: ({ account }) => account.config.dmPolicy ?? "pairing",
    resolveAllowFrom: ({ account }) => (account.config.allowFrom ?? []).map((entry) => String(entry)),
    getPairingPrompt: () => ({
      policy: "pairing",
      allowFrom: [],
      policyPath: "channels.instagram.dmPolicy",
      allowFromPath: "channels.instagram.allowFrom",
      approveHint: formatPairingApproveHint("instagram"),
      normalizeEntry: (raw) => normalizeInstagramUsername(raw),
    }),
  },
  messaging: {
    normalizeTarget: normalizeInstagramMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeInstagramTargetId,
      hint: "<thread:ID|@username>",
    },
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const account = resolveInstagramAccount({ cfg: cfg as CoreConfig, accountId });
      return await resolveInstagramTargets({
        account,
        inputs,
        kind: kind === "group" ? "group" : "peer",
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveInstagramAccount({ cfg: cfg as CoreConfig, accountId });
      const threads = await listInstagramThreads(account, { limit: 100 });
      const q = query?.trim().toLowerCase() ?? "";
      return threads
        .filter((thread) => thread.usernames.length <= 1)
        .flatMap((thread) =>
          thread.usernames.map((username) => ({
            kind: "user" as const,
            id: username,
            name: `@${username}`,
            threadId: thread.id,
          })),
        )
        .filter((entry) => (q ? entry.id.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined);
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveInstagramAccount({ cfg: cfg as CoreConfig, accountId });
      const threads = await listInstagramThreads(account, { limit: 100 });
      const q = query?.trim().toLowerCase() ?? "";
      return threads
        .filter((thread) => thread.usernames.length > 1)
        .map((thread) => ({
          kind: "group" as const,
          id: thread.id,
          name: thread.title || thread.usernames.map((username) => `@${username}`).join(", "),
        }))
        .filter((entry) => (q ? `${entry.id} ${entry.name}`.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined);
    },
  },
  outbound: {
    chunkText: ({ runtime, text, limit }) => runtime.channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 1000,
    sendText: async ({ to, text, accountId }) => {
      const account = resolveInstagramAccount({
        cfg: getInstagramRuntime().config.loadConfig() as CoreConfig,
        accountId: accountId ?? undefined,
      });
      const result = await sendMessageInstagram(to, text, { account });
      return { channel: "instagram", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const account = resolveInstagramAccount({
        cfg: getInstagramRuntime().config.loadConfig() as CoreConfig,
        accountId: accountId ?? undefined,
      });
      const combined = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendMessageInstagram(to, combined, { account });
      return { channel: "instagram", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastPollAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      sessionUsername: snapshot.sessionUsername ?? null,
      cliPath: snapshot.cliPath ?? null,
      probe: snapshot.probe,
      lastPollAt: snapshot.lastPollAt ?? null,
    }),
    probeAccount: async ({ cfg, account }) =>
      await probeInstagram(resolveInstagramAccount({ cfg: cfg as CoreConfig, accountId: account.accountId })),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      cliPath: account.cliPath,
      sessionUsername: account.sessionUsername,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(`Instagram is not configured for account "${account.accountId}".`);
      }
      ctx.log?.info(`[${account.accountId}] starting Instagram provider (${account.cliPath})`);
      const { stop } = await monitorInstagramProvider({
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      return { stop };
    },
  },
};
