import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type { MaxProbe, ResolvedMaxAccount } from "./types.js";
import { listMaxAccountIds, resolveDefaultMaxAccountId, resolveMaxAccount } from "./accounts.js";
import { MaxConfigSchema } from "./config-schema.js";
import { looksLikeMaxTargetId, normalizeMaxMessagingTarget } from "./normalize.js";
import { getMaxRuntime } from "./runtime.js";

// ------------------------------------------------------------------
// Meta — loaded from the platform registry (CHAT_CHANNEL_META)
// ------------------------------------------------------------------
const meta = getChatChannelMeta("max");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function normalizeAllowEntry(entry: string): string {
  return entry.trim().replace(/^max:/i, "").toLowerCase();
}

function formatAllowEntry(entry: string): string {
  return normalizeAllowEntry(entry) || "";
}

function parseReplyToMessageId(replyToId?: string | null) {
  if (!replyToId) {
    return undefined;
  }
  const parsed = Number.parseInt(replyToId, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ------------------------------------------------------------------
// Message Actions
// ------------------------------------------------------------------

const maxMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => getMaxRuntime().channel.max?.messageActions?.listActions?.(ctx) ?? [],
  extractToolSend: (ctx) =>
    getMaxRuntime().channel.max?.messageActions?.extractToolSend?.(ctx) ?? null,
  supportsAction: (ctx) =>
    getMaxRuntime().channel.max?.messageActions?.supportsAction?.(ctx) ?? false,
  handleAction: async (ctx) => {
    const ma = getMaxRuntime().channel.max?.messageActions;
    if (!ma?.handleAction) {
      throw new Error("MAX message actions not available");
    }
    return ma.handleAction(ctx);
  },
};

// ------------------------------------------------------------------
// Channel Plugin
// ------------------------------------------------------------------

export const maxPlugin: ChannelPlugin<ResolvedMaxAccount, MaxProbe> = {
  id: "max",

  meta: {
    ...meta,
  },

  pairing: {
    idLabel: "maxUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveMaxAccount({ cfg });
      const token = account.token?.trim();
      if (!token) {
        throw new Error("MAX token not configured");
      }
      const send =
        getMaxRuntime().channel.max?.sendMessageMax ??
        (() => {
          throw new Error("MAX runtime sendMessageMax not available");
        });
      await send(id, PAIRING_APPROVED_MESSAGE, { accountId: account.accountId });
    },
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    nativeCommands: true,
    blockStreaming: true,
  },

  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },

  reload: { configPrefixes: ["channels.max"] },

  configSchema: buildChannelConfigSchema(MaxConfigSchema),

  config: {
    listAccountIds: (cfg) => listMaxAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMaxAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMaxAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "max",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "max",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveMaxAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const maxCfg = (cfg.channels as Record<string, unknown> | undefined)?.max as
        | { accounts?: Record<string, unknown> }
        | undefined;
      const useAccountPath = Boolean(maxCfg?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.max.accounts.${resolvedAccountId}.`
        : "channels.max.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("max"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- MAX groups: groupPolicy="open" allows any member to trigger the bot (mention-gated). Set channels.max.groupPolicy="allowlist" + channels.max.groupAllowFrom to restrict senders.`,
      ];
    },
  },

  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const account = resolveMaxAccount({ cfg, accountId });
      // MAX groups default to requiring @mention for the bot.
      return account.config.groupPolicy === "open" ? false : true;
    },
  },

  messaging: {
    normalizeTarget: normalizeMaxMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeMaxTargetId,
      hint: "<chatId|max:chatId>",
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },

  actions: maxMessageActions,

  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getMaxRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps, replyToId }) => {
      const send =
        deps?.sendMax ??
        getMaxRuntime().channel.max?.sendMessageMax ??
        (() => {
          throw new Error("MAX runtime sendMessageMax not available");
        });
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const result = await send(to, text, {
        verbose: false,
        replyToMessageId,
        accountId: accountId ?? undefined,
        format: "markdown",
      });
      return { channel: "max", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
      const send =
        deps?.sendMax ??
        getMaxRuntime().channel.max?.sendMessageMax ??
        (() => {
          throw new Error("MAX runtime sendMessageMax not available");
        });
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        replyToMessageId,
        accountId: accountId ?? undefined,
        format: "markdown",
      });
      return { channel: "max", ...result };
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
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "max",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const probe =
        getMaxRuntime().channel.max?.probeMax ??
        (() => {
          throw new Error("MAX runtime probeMax not available");
        });
      return probe(account.token, timeoutMs, account.config.proxy);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "max",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "MAX_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "MAX requires token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "max",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "max",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            max: {
              ...((next.channels as Record<string, unknown>)?.max as Record<string, unknown>),
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
            },
          },
        };
      }
      const maxCfg = (next.channels as Record<string, unknown> | undefined)?.max as
        | Record<string, unknown>
        | undefined;
      return {
        ...next,
        channels: {
          ...next.channels,
          max: {
            ...maxCfg,
            enabled: true,
            accounts: {
              ...(maxCfg?.accounts as Record<string, unknown> | undefined),
              [accountId]: {
                ...((maxCfg?.accounts as Record<string, unknown> | undefined)?.[accountId] as
                  | Record<string, unknown>
                  | undefined),
                enabled: true,
                ...(input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
              },
            },
          },
        },
      };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let maxBotLabel = "";
      try {
        const probe =
          getMaxRuntime().channel.max?.probeMax ??
          (() => {
            throw new Error("MAX runtime probeMax not available");
          });
        const probeResult = await probe(token, 2500, account.config.proxy);
        const username = probeResult.ok ? probeResult.bot?.username?.trim() : null;
        if (username) {
          maxBotLabel = ` (@${username})`;
        }
      } catch (err) {
        if (getMaxRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }
      ctx.log?.info(`[${account.accountId}] starting MAX provider${maxBotLabel}`);
      const monitor =
        getMaxRuntime().channel.max?.monitorMaxProvider ??
        (() => {
          throw new Error("MAX runtime monitorMaxProvider not available");
        });
      return monitor({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        useWebhook: Boolean(account.config.webhookUrl),
        webhookUrl: account.config.webhookUrl,
        webhookSecret: account.config.webhookSecret,
        webhookPath: account.config.webhookPath,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.MAX_BOT_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextMax = (cfg.channels as Record<string, unknown> | undefined)?.max
        ? { ...((cfg.channels as Record<string, unknown>).max as Record<string, unknown>) }
        : undefined;
      let cleared = false;
      let changed = false;
      if (nextMax) {
        if (accountId === DEFAULT_ACCOUNT_ID) {
          if (nextMax.botToken) {
            delete nextMax.botToken;
            cleared = true;
            changed = true;
          }
          if (nextMax.tokenFile) {
            delete nextMax.tokenFile;
            cleared = true;
            changed = true;
          }
        }
        const accounts =
          nextMax.accounts && typeof nextMax.accounts === "object"
            ? { ...(nextMax.accounts as Record<string, unknown>) }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;
            if ("botToken" in nextEntry) {
              const token = nextEntry.botToken;
              if (typeof token === "string" ? token.trim() : token) {
                cleared = true;
              }
              delete nextEntry.botToken;
              changed = true;
            }
            if ("tokenFile" in nextEntry) {
              if (nextEntry.tokenFile) {
                cleared = true;
              }
              delete nextEntry.tokenFile;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextMax.accounts;
            changed = true;
          } else {
            nextMax.accounts = accounts;
          }
        }
      }
      if (changed) {
        if (nextMax && Object.keys(nextMax).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, max: nextMax } as typeof nextCfg.channels;
        } else {
          const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
          delete nextChannels.max;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels as typeof nextCfg.channels;
          } else {
            delete nextCfg.channels;
          }
        }
      }
      const resolved = resolveMaxAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";
      if (changed) {
        await getMaxRuntime().config.writeConfigFile(nextCfg);
      }
      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
};
