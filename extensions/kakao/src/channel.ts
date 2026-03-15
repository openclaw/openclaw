/**
 * OpenClaw KakaoTalk Channel Plugin
 *
 * Integrates KakaoTalk messaging via Kakao i Open Builder skill server.
 *
 * Architecture:
 * 1. User sends message in KakaoTalk Channel
 * 2. Kakao i Open Builder forwards to OpenClaw webhook (skill server)
 * 3. OpenClaw processes and returns response in Kakao format
 * 4. For long responses, uses callback URL for async delivery
 */

import {
  collectAllowlistProviderRestrictSendersWarnings,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  KakaoConfigSchema,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
  type KakaoConfig,
  type ResolvedKakaoAccount,
} from "openclaw/plugin-sdk/kakao";
import { getKakaoRuntime } from "./runtime.js";

// KakaoTalk channel metadata
const meta = {
  id: "kakao",
  label: "KakaoTalk",
  selectionLabel: "KakaoTalk (Kakao i Open Builder)",
  detailLabel: "KakaoTalk Bot",
  docsPath: "/channels/kakao",
  docsLabel: "kakao",
  blurb: "KakaoTalk messaging via Kakao i Open Builder skill server webhook.",
  systemImage: "message.fill",
};

const kakaoConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) =>
    getKakaoRuntime().channel.kakao.resolveKakaoAccount({ cfg, accountId: accountId ?? undefined }),
  resolveAllowFrom: (account: ResolvedKakaoAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^kakao:(?:user:)?/i, "")),
});

const kakaoConfigBase = createScopedChannelConfigBase<ResolvedKakaoAccount, OpenClawConfig>({
  sectionKey: "kakao",
  listAccountIds: (cfg) => getKakaoRuntime().channel.kakao.listKakaoAccountIds(cfg),
  resolveAccount: (cfg, accountId) =>
    getKakaoRuntime().channel.kakao.resolveKakaoAccount({ cfg, accountId: accountId ?? undefined }),
  defaultAccountId: (cfg) => getKakaoRuntime().channel.kakao.resolveDefaultKakaoAccountId(cfg),
  clearBaseFields: ["adminKey", "adminKeyFile"],
});

const resolveKakaoDmPolicy = createScopedDmSecurityResolver<ResolvedKakaoAccount>({
  channelKey: "kakao",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  approveHint: "openclaw pairing approve kakao <code>",
  normalizeEntry: (raw) => raw.replace(/^kakao:(?:user:)?/i, ""),
});

function patchKakaoAccountConfig(
  cfg: OpenClawConfig,
  kakaoConfig: KakaoConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        kakao: {
          ...kakaoConfig,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      kakao: {
        ...kakaoConfig,
        accounts: {
          ...kakaoConfig.accounts,
          [accountId]: {
            ...kakaoConfig.accounts?.[accountId],
            ...patch,
          },
        },
      },
    },
  };
}

export const kakaoPlugin: ChannelPlugin<ResolvedKakaoAccount> = {
  id: "kakao",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "kakaoUserId",
    normalizeAllowEntry: (entry) => {
      // Kakao user IDs are encrypted strings; only strip prefix variants.
      return entry.replace(/^kakao:(?:user:)?/i, "");
    },
    notifyApproval: async ({ cfg, id }) => {
      const kakao = getKakaoRuntime().channel.kakao;
      const account = kakao.resolveKakaoAccount({ cfg });
      if (!account.adminKey) {
        throw new Error("Kakao admin key not configured");
      }
      // Note: Kakao doesn't support push messages without user consent
      // This is a no-op for now; approval notification is shown in-chat
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true, // Kakao skill server doesn't support streaming
  },
  reload: { configPrefixes: ["channels.kakao"] },
  configSchema: buildChannelConfigSchema(KakaoConfigSchema),
  config: {
    ...kakaoConfigBase,
    isConfigured: (account) => Boolean(account.adminKey?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.adminKey?.trim()),
      tokenSource: account.tokenSource ?? undefined,
    }),
    ...kakaoConfigAccessors,
  },
  security: {
    resolveDmPolicy: resolveKakaoDmPolicy,
    collectWarnings: ({ account, cfg }) => {
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.kakao !== undefined,
        configuredGroupPolicy: undefined, // Kakao doesn't support groups via skill server
        surface: "KakaoTalk channels",
        openScope: "any user in channel",
        groupPolicyPath: "channels.kakao.groupPolicy",
        groupAllowFromPath: "channels.kakao.groupAllowFrom",
        mentionGated: false,
      });
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed.replace(/^kakao:(?:user:)?/i, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        // Kakao user IDs are encrypted strings
        return /^[a-zA-Z0-9_-]+$/.test(trimmed) || /^kakao:/i.test(trimmed);
      },
      hint: "<kakaoUserId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) =>
      getKakaoRuntime().channel.kakao.normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => {
      const kakaoConfig = (cfg.channels?.kakao ?? {}) as KakaoConfig;
      return patchKakaoAccountConfig(cfg, kakaoConfig, accountId, { name });
    },
    validateInput: ({ accountId, input }) => {
      const typedInput = input as {
        useEnv?: boolean;
        adminKey?: string;
        adminKeyFile?: string;
      };
      if (typedInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "KAKAO_ADMIN_KEY can only be used for the default account.";
      }
      if (!typedInput.useEnv && !typedInput.adminKey && !typedInput.adminKeyFile) {
        return "Kakao requires adminKey or --admin-key-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        name?: string;
        useEnv?: boolean;
        adminKey?: string;
        adminKeyFile?: string;
      };
      const kakaoConfig = (cfg.channels?.kakao ?? {}) as KakaoConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            kakao: {
              ...kakaoConfig,
              enabled: true,
              ...(typedInput.name ? { name: typedInput.name } : {}),
              ...(typedInput.useEnv
                ? {}
                : typedInput.adminKeyFile
                  ? { adminKeyFile: typedInput.adminKeyFile }
                  : typedInput.adminKey
                    ? { adminKey: typedInput.adminKey }
                    : {}),
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          kakao: {
            ...kakaoConfig,
            enabled: true,
            accounts: {
              ...kakaoConfig.accounts,
              [accountId]: {
                ...kakaoConfig.accounts?.[accountId],
                enabled: true,
                ...(typedInput.name ? { name: typedInput.name } : {}),
                ...(typedInput.adminKeyFile
                  ? { adminKeyFile: typedInput.adminKeyFile }
                  : typedInput.adminKey
                    ? { adminKey: typedInput.adminKey }
                    : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "callback", // Kakao uses callback URL for responses
    chunker: (text, limit) => getKakaoRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 900, // Kakao simpleText limit is 1000, leave margin
    sendText: async () => {
      // Kakao skill server responses are sent via HTTP response, not outbound push
      // This is handled in the webhook handler
      return { channel: "kakao", messageId: "callback", chatId: "callback" };
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
    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        const accountId = account.accountId ?? DEFAULT_ACCOUNT_ID;
        if (!account.adminKey?.trim()) {
          issues.push({
            channel: "kakao",
            accountId,
            kind: "config",
            message: "Kakao admin key not configured",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      getKakaoRuntime().channel.kakao.probeKakaoBot(account.adminKey, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.adminKey?.trim());
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        runtime,
        probe,
      });
      return {
        ...base,
        tokenSource: account.tokenSource,
        mode: "webhook",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const adminKey = account.adminKey?.trim();
      if (!adminKey) {
        throw new Error(
          `Kakao webhook mode requires a non-empty admin key for account "${account.accountId}".`,
        );
      }

      ctx.log?.info(`[${account.accountId}] starting Kakao provider`);

      const monitor = await getKakaoRuntime().channel.kakao.monitorKakaoProvider({
        adminKey,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath ?? "/kakao/skill",
      });

      return monitor;
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.KAKAO_ADMIN_KEY?.trim() ?? "";
      const nextCfg = { ...cfg } as OpenClawConfig;
      const kakaoConfig = (cfg.channels?.kakao ?? {}) as KakaoConfig;
      const nextKakao = { ...kakaoConfig };
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (nextKakao.adminKey || nextKakao.adminKeyFile) {
          delete nextKakao.adminKey;
          delete nextKakao.adminKeyFile;
          cleared = true;
          changed = true;
        }
      }

      const accountCleanup = clearAccountEntryFields({
        accounts: nextKakao.accounts,
        accountId,
        fields: ["adminKey", "adminKeyFile"],
        markClearedOnFieldPresence: true,
      });
      if (accountCleanup.changed) {
        changed = true;
        if (accountCleanup.cleared) {
          cleared = true;
        }
        if (accountCleanup.nextAccounts) {
          nextKakao.accounts = accountCleanup.nextAccounts;
        } else {
          delete nextKakao.accounts;
        }
      }

      if (changed) {
        if (Object.keys(nextKakao).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, kakao: nextKakao };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete (nextChannels as Record<string, unknown>).kakao;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await getKakaoRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = getKakaoRuntime().channel.kakao.resolveKakaoAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";

      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "",
      "### KakaoTalk Messages",
      "KakaoTalk uses Kakao i Open Builder skill server format.",
      "",
      "**Limitations:**",
      "- Messages are delivered via webhook response (not push)",
      "- Maximum 1000 characters per text block",
      "- Responses must complete within 5 seconds (async callback available)",
      "- No streaming support",
      "",
      "**Auto-formatting:**",
      "- Long messages are automatically split into chunks",
      "- Korean text is preserved as-is",
      "",
    ],
  },
};
