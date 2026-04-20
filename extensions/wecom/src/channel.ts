import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import { type ChannelPlugin, type OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  listWeComAccountIds,
  resolveWeComAccountMulti,
  resolveDefaultWeComAccountId,
  hasMultiAccounts,
} from "./accounts.js";
import type { WeComMultiAccountConfig } from "./accounts.js";
import { wecomChannelConfigSchema } from "./config-schema.js";
import { CHANNEL_ID, TEXT_CHUNK_LIMIT } from "./const.js";
import { wecomOutboundLog } from "./loggers.js";
import { uploadAndSendMedia } from "./media-uploader.js";
import { monitorWeComProvider } from "./monitor.js";
import { wecomSetupWizard, wecomSetupAdapter } from "./onboarding.js";
import {
  buildAccountScopedDmSecurityPolicy,
  type ChannelSecurityDmPolicyCompat,
} from "./openclaw-compat.js";
import { formatPairingApproveHint, DEFAULT_ACCOUNT_ID } from "./openclaw-compat.js";
import { getWeComRuntime } from "./runtime.js";
import { getWeComWebSocket } from "./state-manager.js";
import type { WeComConfig, ResolvedWeComAccount } from "./utils.js";

/**
 * Send a WeCom message proactively using the Bot WebSocket.
 * Requires an active WSClient connection for the target account.
 */
async function sendWeComMessage({
  to,
  content,
  accountId,
  cfg,
}: {
  to: string;
  content: string;
  accountId?: string;
  cfg?: OpenClawConfig;
}): Promise<{ channel: string; messageId: string; chatId: string }> {
  const resolvedAccountId =
    accountId ?? (cfg ? resolveDefaultWeComAccountId(cfg) : DEFAULT_ACCOUNT_ID);

  // Extract target from `to` (format is "${CHANNEL_ID}:xxx" or a plain target string)
  const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
  const chatId = to.replace(channelPrefix, "");

  const wsClient = getWeComWebSocket(resolvedAccountId);
  if (!wsClient?.isConnected) {
    throw new Error(
      `WSClient not connected for account ${resolvedAccountId}. ` +
        `Ensure botId + secret are configured and the gateway is running.`,
    );
  }

  const result = await wsClient.sendMessage(chatId, {
    msgtype: "markdown",
    markdown: { content },
  });
  const messageId = result?.headers?.req_id ?? `wecom-${Date.now()}`;
  return { channel: CHANNEL_ID, messageId, chatId };
}

// WeCom channel metadata
const meta = {
  id: CHANNEL_ID,
  label: "WeCom",
  selectionLabel: "WeCom (企业微信)",
  detailLabel: "WeCom Bot（Official API）",
  docsPath: `/channels/${CHANNEL_ID}`,
  docsLabel: CHANNEL_ID,
  blurb: "connect to WeCom via official Wecom Bot API with document/meeting/messaging skills.",
  systemImage: "message.fill",
};
export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: CHANNEL_ID,
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: (entry) =>
      entry.replace(new RegExp(`^(${CHANNEL_ID}|user):`, "i"), "").trim(),
    notifyApproval: async () => {
      // sendWeComMessage({
      //   to: id,
      //   content: " pairing approved",
      //   accountId: cfg.accountId,
      // });
      // Pairing approved for user
    },
  },
  setupWizard: wecomSetupWizard,
  setup: wecomSetupAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: wecomChannelConfigSchema,
  config: {
    // Multi-account: list all account IDs
    listAccountIds: (cfg) => listWeComAccountIds(cfg),

    // Multi-account: resolve account config by accountId
    resolveAccount: (cfg, accountId) => resolveWeComAccountMulti({ cfg, accountId }),

    // Multi-account: get default account ID
    defaultAccountId: (cfg) => resolveDefaultWeComAccountId(cfg),

    // Multi-account: set account enabled state
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      if (!hasMultiAccounts(cfg)) {
        // Single-account mode: set top-level enabled
        const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [CHANNEL_ID]: {
              ...wecomConfig,
              enabled,
            },
          },
        };
      }
      // Multi-account mode: set accounts[accountId].enabled
      const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComMultiAccountConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...wecomConfig,
            accounts: {
              ...wecomConfig.accounts,
              [accountId]: {
                ...wecomConfig.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },

    // Multi-account: delete account
    deleteAccount: ({ cfg, accountId }) => {
      if (!hasMultiAccounts(cfg)) {
        // Single-account mode: delete the entire wecom config
        const next = { ...cfg } as OpenClawConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>)[CHANNEL_ID];
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      // Delete the specified account (normalize ID to match config keys consistently)
      const wecomConfig = cfg.channels?.[CHANNEL_ID] as WeComMultiAccountConfig | undefined;
      const accounts = { ...wecomConfig?.accounts };
      const normalizedId = accountId.toLowerCase().trim();
      // Find the actual key that matches the normalized accountId
      const matchedKey =
        Object.keys(accounts).find((k) => k.toLowerCase().trim() === normalizedId) ?? accountId;
      delete accounts[matchedKey];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...wecomConfig,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },

    // Check if configured (requires Bot credentials: botId + secret)
    isConfigured: (account) => Boolean(account.botId?.trim() && account.secret?.trim()),

    // Describe account info
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botId?.trim() && account.secret?.trim()),
      botId: account.botId,
      websocketUrl: account.websocketUrl,
    }),

    // Resolve allow-from list (multi-account: resolved by accountId)
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWeComAccountMulti({ cfg, accountId });
      return (account.config.allowFrom ?? []).map((entry) => String(entry));
    },

    // Format allow-from list
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const result = buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: CHANNEL_ID,
        accountId,
        fallbackAccountId: account.accountId,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        defaultPolicy: "open",
        policyPathSuffix: "dmPolicy",
        approveHint: formatPairingApproveHint(CHANNEL_ID),
        normalizeEntry: (raw) => raw.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim(),
      });
      return result as ChannelSecurityDmPolicyCompat;
    },
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveWeComAccountMulti({ cfg, accountId });
      const warnings: string[] = [];

      // Dynamically construct config path (distinguish single-account / multi-account)
      const isMulti = hasMultiAccounts(cfg);
      const basePath =
        isMulti && accountId
          ? `channels.${CHANNEL_ID}.accounts.${accountId}.`
          : `channels.${CHANNEL_ID}.`;

      // DM policy warning
      const dmPolicy = account.config.dmPolicy ?? "open";
      if (dmPolicy === "open") {
        const hasWildcard = (account.config.allowFrom ?? []).some(
          (entry) => String(entry).trim() === "*",
        );
        if (!hasWildcard) {
          warnings.push(
            `- 企业微信[${account.accountId}]私信：dmPolicy="open" 但 allowFrom 未包含 "*"。任何人都可以发消息，但允许列表为空可能导致意外行为。建议设置 ${basePath}allowFrom=["*"] 或使用 dmPolicy="pairing"。`,
          );
        }
      }

      // Group policy warning
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
      if (groupPolicy === "open") {
        warnings.push(
          `- 企业微信[${account.accountId}]群组：groupPolicy="open" 允许所有群组中的成员触发。设置 ${basePath}groupPolicy="allowlist" + ${basePath}groupAllowFrom 来限制群组。`,
        );
      }

      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        return Boolean(trimmed);
      },
      hint: "<userId|groupId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: (text, limit) => getWeComRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: TEXT_CHUNK_LIMIT,
    sendText: async ({ to, text, accountId, cfg }) => {
      return sendWeComMessage({ to, content: text, accountId: accountId ?? undefined, cfg });
    },
    sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId, cfg }) => {
      const resolvedAccountId =
        accountId ?? (cfg ? resolveDefaultWeComAccountId(cfg) : DEFAULT_ACCOUNT_ID);
      const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
      const chatId = to.replace(channelPrefix, "");

      // If no mediaUrl, fall back to plain text
      if (!mediaUrl) {
        return sendWeComMessage({ to, content: text || "", accountId: resolvedAccountId, cfg });
      }

      const wsClient = getWeComWebSocket(resolvedAccountId);
      if (!wsClient?.isConnected) {
        throw new Error(
          `WSClient not connected for account ${resolvedAccountId}. ` +
            `Cannot send media without an active WS connection.`,
        );
      }

      const result = await uploadAndSendMedia({
        wsClient,
        mediaUrl,
        chatId,
        mediaLocalRoots,
      });

      if (result.rejected) {
        return sendWeComMessage({
          to,
          content: `⚠️ ${result.rejectReason}`,
          accountId: resolvedAccountId,
          cfg,
        });
      }

      if (!result.ok) {
        const fallbackContent = text ? `${text}\n📎 ${mediaUrl}` : `📎 ${mediaUrl}`;
        return sendWeComMessage({
          to,
          content: fallbackContent,
          accountId: resolvedAccountId,
          cfg,
        });
      }

      if (text) {
        await sendWeComMessage({ to, content: text, accountId: resolvedAccountId, cfg });
      }
      if (result.downgradeNote) {
        await sendWeComMessage({
          to,
          content: `ℹ️ ${result.downgradeNote}`,
          accountId: resolvedAccountId,
          cfg,
        });
      }

      wecomOutboundLog.debug(`media sent via WS (accountId=${resolvedAccountId})`);

      return {
        channel: CHANNEL_ID,
        messageId: result.messageId!,
        chatId,
      };
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
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = entry.accountId ?? DEFAULT_ACCOUNT_ID;
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled) {
          return [];
        }
        const issues: ChannelStatusIssue[] = [];
        if (!configured) {
          issues.push({
            channel: CHANNEL_ID,
            accountId,
            kind: "config",
            message: "企业微信机器人 ID 或 Secret 未配置",
            fix: "Run: openclaw channels add wecom --bot-id <id> --secret <secret>",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async () => {
      return { ok: true, status: 200 };
    },
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.botId?.trim() && account.secret?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      // Multi-account: resolve account config by accountId
      const account = resolveWeComAccountMulti({ cfg: ctx.cfg, accountId: ctx.accountId });

      ctx.log?.info(`starting wecom[${ctx.accountId}] (name: ${account.name}, mode: websocket)`);

      // Bot WebSocket listener (requires botId + secret)
      const hasBotCredentials = Boolean(account.botId?.trim() && account.secret?.trim());
      if (!hasBotCredentials) {
        throw new Error(
          `Cannot start wecom[${ctx.accountId}]: botId + secret are required. ` +
            `Run 'openclaw channels add wecom' to configure.`,
        );
      }

      return monitorWeComProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        setStatus: ctx.setStatus as unknown as (next: Record<string, unknown>) => void,
      });
    },
    logoutAccount: async ({ cfg, accountId }) => {
      const resolvedAccountId = accountId ?? resolveDefaultWeComAccountId(cfg);
      const isMulti = hasMultiAccounts(cfg);
      let nextCfg = { ...cfg } as OpenClawConfig;
      let cleared = false;
      let changed = false;

      if (!isMulti) {
        // Single-account mode: delete top-level botId/secret
        const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
        const nextWecom = { ...wecomConfig };

        if (nextWecom.botId || nextWecom.secret) {
          delete nextWecom.botId;
          delete nextWecom.secret;
          cleared = true;
          changed = true;
        }

        if (changed) {
          if (Object.keys(nextWecom).length > 0) {
            nextCfg.channels = { ...nextCfg.channels, [CHANNEL_ID]: nextWecom };
          } else {
            const nextChannels = { ...nextCfg.channels };
            delete (nextChannels as Record<string, unknown>)[CHANNEL_ID];
            if (Object.keys(nextChannels).length > 0) {
              nextCfg.channels = nextChannels;
            } else {
              delete nextCfg.channels;
            }
          }
        }
      } else {
        // Multi-account mode: delete botId/secret for the specified account
        const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComMultiAccountConfig;
        const accountCfg = wecomConfig.accounts?.[resolvedAccountId];

        if (accountCfg?.botId || accountCfg?.secret) {
          const nextAccount = { ...accountCfg };
          delete nextAccount.botId;
          delete nextAccount.secret;
          cleared = true;
          changed = true;

          const nextAccounts = { ...wecomConfig.accounts };
          if (Object.keys(nextAccount).length > 0) {
            nextAccounts[resolvedAccountId] = nextAccount;
          } else {
            delete nextAccounts[resolvedAccountId];
          }

          nextCfg = {
            ...cfg,
            channels: {
              ...cfg.channels,
              [CHANNEL_ID]: {
                ...wecomConfig,
                accounts: Object.keys(nextAccounts).length > 0 ? nextAccounts : undefined,
              },
            },
          } as OpenClawConfig;
        }
      }

      if (changed) {
        await getWeComRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveWeComAccountMulti({
        cfg: changed ? nextCfg : cfg,
        accountId: resolvedAccountId,
      });
      const loggedOut = !resolved.botId && !resolved.secret;

      return { cleared, envToken: false, loggedOut };
    },
  },
};
