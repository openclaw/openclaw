import {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type { CoreConfig, ResolvedSaintEmailAccount } from "./types.js";
import {
  listSaintEmailAccountIds,
  resolveDefaultSaintEmailAccountId,
  resolveSaintEmailAccount,
} from "./accounts.js";
import { SaintEmailConfigSchema } from "./config-schema.js";
import { monitorSaintEmailProvider } from "./monitor.js";
import { sendSaintEmail } from "./send.js";
import { SAINT_EMAIL_CHANNEL_ID } from "./types.js";

function hasOauth2Credentials(account: ResolvedSaintEmailAccount): boolean {
  return Boolean(account.oauth2?.serviceAccountEmail && account.oauth2?.privateKey);
}

function hasAuthConfig(account: ResolvedSaintEmailAccount): boolean {
  return Boolean(account.accessToken?.trim()) || hasOauth2Credentials(account);
}

const runningMonitors = new Map<string, () => void>();

const meta = {
  id: SAINT_EMAIL_CHANNEL_ID,
  label: "Email",
  selectionLabel: "Email (Gmail API)",
  docsPath: "/channels/email",
  docsLabel: "email",
  blurb: "Inbound/outbound Gmail with threading support.",
  aliases: ["saint-email", "gmail"],
  order: 66,
  quickstartAllowFrom: true,
};

export const saintEmailPlugin: ChannelPlugin<ResolvedSaintEmailAccount> = {
  id: SAINT_EMAIL_CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "thread"],
    media: true,
    threads: true,
    blockStreaming: true,
    nativeCommands: false,
    reactions: false,
  },
  reload: { configPrefixes: ["channels.email"] },
  pairing: {
    idLabel: "email",
    normalizeAllowEntry: (entry) => entry.trim().toLowerCase(),
  },
  configSchema: buildChannelConfigSchema(SaintEmailConfigSchema),
  config: {
    listAccountIds: (cfg) => listSaintEmailAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveSaintEmailAccount({
        cfg: cfg as CoreConfig,
        accountId,
      }),
    defaultAccountId: (cfg) => resolveDefaultSaintEmailAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "email",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "email",
        accountId,
        clearBaseFields: [
          "name",
          "address",
          "userId",
          "accessToken",
          "oauth2",
          "allowFrom",
          "dmPolicy",
          "maxAttachmentMb",
        ],
      }),
    isConfigured: (account) => Boolean(account.address?.trim() && hasAuthConfig(account)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.address?.trim() && hasAuthConfig(account)),
      address: account.address || "[missing]",
      userId: account.userId,
      pollIntervalSec: account.pollIntervalSec,
      dmPolicy: account.dmPolicy,
      running: runningMonitors.has(account.accountId),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveSaintEmailAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim().toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const accounts = cfg.channels?.email?.accounts;
      const useAccountPath = Boolean(
        accounts &&
        Object.keys(accounts).some((key) => key.toLowerCase() === resolvedAccountId.toLowerCase()),
      );
      const basePath = useAccountPath
        ? `channels.email.accounts.${resolvedAccountId}.`
        : "channels.email.";
      return {
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("email"),
        normalizeEntry: (raw) => raw.trim().toLowerCase(),
      };
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => accountId?.trim() || DEFAULT_ACCOUNT_ID,
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "email",
        accountId,
        name,
      }),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const named = applyAccountNameToChannelSection({
        cfg,
        channelKey: "email",
        accountId,
        name: input.name,
      });
      const section = named.channels?.email ?? {};
      const next = {
        ...named,
        channels: {
          ...named.channels,
          email:
            accountId === DEFAULT_ACCOUNT_ID
              ? {
                  ...section,
                  enabled: true,
                  ...(input.token ? { accessToken: input.token } : {}),
                  ...(input.userId ? { userId: input.userId } : {}),
                  ...(input.name ? { name: input.name } : {}),
                }
              : {
                  ...section,
                  enabled: true,
                  accounts: {
                    ...(section.accounts ?? {}),
                    [accountId]: {
                      ...(section.accounts?.[accountId] ?? {}),
                      enabled: true,
                      ...(input.token ? { accessToken: input.token } : {}),
                      ...(input.userId ? { userId: input.userId } : {}),
                      ...(input.name ? { name: input.name } : {}),
                    },
                  },
                },
        },
      } as OpenClawConfig;
      return next;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendPayload: async ({ to, payload, accountId, cfg }) => {
      const account = resolveSaintEmailAccount({ cfg: cfg as CoreConfig, accountId });
      return await sendSaintEmail({
        account,
        to,
        payload,
      });
    },
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveSaintEmailAccount({ cfg: cfg as CoreConfig, accountId });
      return await sendSaintEmail({
        account,
        to,
        payload: { text },
      });
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveSaintEmailAccount({ cfg: cfg as CoreConfig, accountId });
      return await sendSaintEmail({
        account,
        to,
        payload: { text, mediaUrl },
      });
    },
  },
  status: {
    buildChannelSummary: ({ account, snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      pollIntervalSec: account.pollIntervalSec,
      dmPolicy: snapshot.dmPolicy ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.address?.trim() && hasAuthConfig(account)),
      address: account.address || "[missing]",
      userId: account.userId,
      running: runtime?.running ?? false,
      dmPolicy: account.dmPolicy,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.enabled) {
        throw new Error(`Email account ${account.accountId} is disabled`);
      }
      if (!account.address || !hasAuthConfig(account)) {
        throw new Error(`Email account ${account.accountId} is not configured`);
      }
      const { stop } = await monitorSaintEmailProvider({
        account,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      runningMonitors.set(account.accountId, stop);
      return {
        stop: () => {
          runningMonitors.delete(account.accountId);
          stop();
        },
      };
    },
    stopAccount: async (ctx) => {
      const stop = runningMonitors.get(ctx.accountId);
      if (!stop) {
        return;
      }
      runningMonitors.delete(ctx.accountId);
      stop();
    },
  },
};
