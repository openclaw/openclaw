import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type { InfoflowAccountConfig, InfoflowAtOptions, ResolvedInfoflowAccount } from "./types.js";
import { startInfoflowMonitor } from "./monitor.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowPrivateMessage, sendInfoflowGroupMessage } from "./send.js";

// Re-export types for external consumers
export type { InfoflowAccountConfig, ResolvedInfoflowAccount } from "./types.js";

// ---------------------------------------------------------------------------
// Account resolution helpers
// ---------------------------------------------------------------------------

function getChannelSection(cfg: OpenClawConfig): InfoflowAccountConfig | undefined {
  return cfg.channels?.["infoflow"] as InfoflowAccountConfig | undefined;
}

function listInfoflowAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = getChannelSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }
  const ids = Object.keys(accounts).filter(Boolean);
  return ids.length === 0 ? [DEFAULT_ACCOUNT_ID] : ids.toSorted((a, b) => a.localeCompare(b));
}

function resolveDefaultInfoflowAccountId(cfg: OpenClawConfig): string {
  const channel = getChannelSection(cfg);
  if (channel?.defaultAccount?.trim()) {
    return channel.defaultAccount.trim();
  }
  const ids = listInfoflowAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function mergeInfoflowAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): {
  apiHost: string;
  check_token: string;
  encodingAESKey: string;
  appKey: string;
  appSecret: string;
  enabled?: boolean;
  name?: string;
  robotName?: string;
  requireMention?: boolean;
} {
  const raw = getChannelSection(cfg) ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = raw.accounts?.[accountId] ?? {};
  return { ...base, ...account } as {
    apiHost: string;
    check_token: string;
    encodingAESKey: string;
    appKey: string;
    appSecret: string;
    enabled?: boolean;
    name?: string;
    robotName?: string;
    requireMention?: boolean;
  };
}

export function resolveInfoflowAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedInfoflowAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = getChannelSection(params.cfg)?.enabled !== false;
  const merged = mergeInfoflowAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const apiHost = merged.apiHost ?? "";
  const check_token = merged.check_token ?? "";
  const encodingAESKey = merged.encodingAESKey ?? "";
  const appKey = merged.appKey ?? "";
  const appSecret = merged.appSecret ?? "";
  const configured = Boolean(check_token) && Boolean(appKey) && Boolean(appSecret);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    config: {
      enabled: merged.enabled,
      name: merged.name,
      apiHost,
      check_token,
      encodingAESKey,
      appKey,
      appSecret,
      robotName: merged.robotName?.trim() || undefined,
      requireMention: merged.requireMention,
    },
  };
}

// ---------------------------------------------------------------------------
// Channel plugin
// ---------------------------------------------------------------------------

export const infoflowPlugin: ChannelPlugin<ResolvedInfoflowAccount> = {
  id: "infoflow",
  meta: {
    id: "infoflow",
    label: "Infoflow",
    selectionLabel: "Infoflow (如流)",
    docsPath: "/channels/infoflow",
    blurb: "Baidu Infoflow enterprise messaging platform.",
    showConfigured: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    nativeCommands: true,
  },
  reload: { configPrefixes: ["channels.infoflow"] },
  config: {
    listAccountIds: (cfg) => listInfoflowAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveInfoflowAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultInfoflowAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "infoflow",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "infoflow",
        accountId,
        clearBaseFields: ["check_token", "encodingAESKey", "appKey", "appSecret", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channelCfg = getChannelSection(cfg);
      const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.infoflow.accounts.${resolvedAccountId}.`
        : "channels.infoflow.";

      return {
        policy: ((account.config as Record<string, unknown>).dmPolicy as string) ?? "open",
        allowFrom: ((account.config as Record<string, unknown>).allowFrom as string[]) ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        normalizeEntry: (raw: string) => raw.replace(/^infoflow:/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy =
        ((account.config as Record<string, unknown>).groupPolicy as string) ??
        defaultGroupPolicy ??
        "open";

      if (groupPolicy === "open") {
        warnings.push(
          `- Infoflow groups: groupPolicy="open" allows any group to trigger. Consider setting channels.infoflow.groupPolicy="allowlist".`,
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const channelCfg = getChannelSection(cfg);
      const accountCfg =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? channelCfg?.accounts?.[accountId]
          : channelCfg;
      return (accountCfg as Record<string, unknown> | undefined)?.requireMention !== false;
    },
    resolveToolPolicy: () => {
      // Return undefined to use global policy
      return undefined;
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "infoflow",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token) {
        return "Infoflow requires --token (check_token).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "infoflow",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "infoflow" })
          : namedConfig;

      const patch: Record<string, unknown> = {};
      if (input.token) {
        patch.check_token = input.token;
      }

      const existing = (next.channels?.["infoflow"] ?? {}) as Record<string, unknown>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            infoflow: {
              ...existing,
              enabled: true,
              ...patch,
            },
          },
        } as OpenClawConfig;
      }
      const existingAccounts = (existing.accounts ?? {}) as Record<string, Record<string, unknown>>;
      return {
        ...next,
        channels: {
          ...next.channels,
          infoflow: {
            ...existing,
            enabled: true,
            accounts: {
              ...existingAccounts,
              [accountId]: {
                ...existingAccounts[accountId],
                enabled: true,
                ...patch,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 4000,
    chunker: (text, limit) => getInfoflowRuntime().channel.text.chunkText(text, limit),
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveInfoflowAccount({ cfg, accountId });
      const { apiHost, appKey, appSecret } = account.config;

      if (!appKey || !appSecret) {
        throw new Error("Infoflow appKey/appSecret not configured.");
      }

      const target = to.replace(/^infoflow:/i, "");

      // Check if target is a group (format: group:123 or group:123?at=user1,user2 or group:123?atall=true)
      const groupMatch = target.match(/^group:(\d+)/i);
      if (groupMatch) {
        const groupId = Number(groupMatch[1]);

        // Parse AT options from query string
        let atOptions: InfoflowAtOptions | undefined;
        const atAllMatch = target.match(/[?&]atall=true/i);
        const atMatch = target.match(/[?&]at=([^&]+)/);
        if (atAllMatch) {
          atOptions = { atAll: true };
        } else if (atMatch) {
          const atUserIds = atMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
          if (atUserIds.length > 0) {
            atOptions = { atUserIds };
          }
        }

        const result = await sendInfoflowGroupMessage({
          apiHost,
          appKey,
          appSecret,
          groupId,
          content: text,
          atOptions,
        });
        return {
          channel: "infoflow",
          messageId: result.ok ? (result.messageid ?? "sent") : "failed",
        };
      }

      // Private message (DM)
      const result = await sendInfoflowPrivateMessage({
        apiHost,
        appKey,
        appSecret,
        touser: target,
        content: text,
      });
      return { channel: "infoflow", messageId: result.ok ? (result.msgkey ?? "sent") : "failed" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Infoflow webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });
      const unregister = await startInfoflowMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
