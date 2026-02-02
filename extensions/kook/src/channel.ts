// KOOK Channel Plugin Implementation

import type { ChannelPlugin, ResolvedKookAccount } from "openclaw/plugin-sdk";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk";
import {
  resolveKookAccount,
  listKookAccountIds,
  normalizeKookAccountId as normalizeAccountId,
  DEFAULT_KOOK_ACCOUNT_ID as DEFAULT_ACCOUNT_ID,
  kookOnboardingAdapter,
} from "openclaw/plugin-sdk";
import { getKookRuntime } from "./runtime.js";

/**
 * KOOK Channel Plugin
 */
export const kookPlugin: ChannelPlugin<ResolvedKookAccount> = {
  id: "kook",
  meta: {
    id: "kook",
    label: "KOOK",
    selectionLabel: "KOOK (Bot API)",
    detailLabel: "KOOK Bot",
    docsPath: "/channels/kook",
    docsLabel: "kook",
    blurb: "KOOK (开黑啦) - Chinese gaming voice chat platform",
    systemImage: "message.badge",
  },

  /**
   * Message Actions
   * Delegates to Runtime (Core implementation)
   * Same pattern as Discord
   */
  actions: {
    listActions: (ctx) => getKookRuntime().channel.kook.messageActions.listActions(ctx),
    extractToolSend: (ctx) => getKookRuntime().channel.kook.messageActions.extractToolSend(ctx),
    handleAction: async (ctx) =>
      await getKookRuntime().channel.kook.messageActions.handleAction(ctx),
  } as ChannelMessageActionAdapter,

  /**
   * Onboarding
   */
  onboarding: kookOnboardingAdapter,

  /**
   * Pairing support for DM approval
   */
  pairing: {
    idLabel: "kookUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(kook|user):/i, "").replace(/^<@(\d+)>$/, "$1"),
    notifyApproval: async ({ id }) => {
      await getKookRuntime().channel.kook.sendMessageKook(
        `user:${id}`,
        "✅ Your pairing request has been approved! You can now send messages to this bot.",
      );
    },
  },

  /**
   * Capabilities
   */
  capabilities: {
    chatTypes: ["direct", "channel"],
    polls: false, // KOOK doesn't have native polls
    reactions: true,
    threads: false,
    media: true,
    nativeCommands: false,
  },

  /**
   * Configuration management
   */
  config: {
    listAccountIds: (cfg) => listKookAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveKookAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const kookCfg = cfg.channels?.kook as Record<string, unknown> | undefined;
      if (!kookCfg) {
        return cfg;
      }

      const accounts = (kookCfg.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const accountCfg = accounts[accountId] ?? {};

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          kook: {
            ...kookCfg,
            accounts: {
              ...accounts,
              [accountId]: { ...accountCfg, enabled },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const kookCfg = cfg.channels?.kook as Record<string, unknown> | undefined;
      if (!kookCfg) {
        return cfg;
      }

      const accounts = { ...(kookCfg.accounts as Record<string, unknown> | undefined) };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          kook: { ...kookCfg, accounts },
        },
      };
    },
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveKookAccount({ cfg, accountId });
      return account.config.dm?.allowFrom?.map(String) ?? [];
    },
    formatAllowFrom: ({ allowFrom }) => allowFrom,
  },

  /**
   * Security policies
   */
  security: {
    resolveDmPolicy: ({ accountId, account }) => ({
      policy: account.config.dm?.policy ?? "allowlist",
      allowFrom: account.config.dm?.allowFrom?.map(String) ?? [],
      allowFromPath: `channels.kook.accounts.${accountId}.dm.allowFrom`,
      approveHint: "Reply /approve <user_id> to approve",
      normalizeEntry: (raw: string) =>
        raw.replace(/^(kook|user):/i, "").replace(/^<@(\d+)>$/, "$1"),
    }),
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (!account.token?.trim()) {
        warnings.push("KOOK token not configured");
      }
      if (account.config.dm?.policy === "open" && account.config.groupPolicy === "open") {
        warnings.push("Both DM and group policies are open - bot will respond to everyone");
      }
      return warnings;
    },
  },

  /**
   * Messaging
   */
  messaging: {
    normalizeTarget: (target: string) => {
      // Normalize target format
      if (target.startsWith("user:") || target.startsWith("channel:")) {
        return target;
      }
      // Default to channel if just an ID
      return target;
    },
    targetResolver: {
      looksLikeId: (input: string) => /^\d+$/.test(input),
      hint: "<channelId|user:ID|channel:ID>",
    },
  },

  /**
   * Outbound messaging
   */
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000, // KOOK has 2000 char limit
    pollMaxOptions: 0, // No poll support
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await getKookRuntime().channel.kook.sendMessageKook(to, text, {
        accountId: accountId ?? undefined,
        quote: replyToId ?? undefined,
      });
      return { channel: "kook", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      // For KOOK, we send media URL as part of the message
      // Type 2 for image, but we'll use kmarkdown for flexibility
      const content = mediaUrl ? (text ? `${text}\n${mediaUrl}` : mediaUrl) : text;
      const result = await getKookRuntime().channel.kook.sendMessageKook(to, content, {
        accountId: accountId ?? undefined,
        quote: replyToId ?? undefined,
        type: 9, // KMarkdown for better formatting
      });
      return { channel: "kook", ...result };
    },
  },

  /**
   * Gateway
   */
  gateway: {
    startAccount: async (ctx) => {
      console.log(`[KOOK-CHANNEL] startAccount called for account: ${ctx.account.accountId}`);
      console.log(
        `[KOOK-CHANNEL] Token check: exists=${!!ctx.account.token}, length=${ctx.account.token?.length || 0}, source=${ctx.account.tokenSource}`,
      );

      const token = ctx.account.token.trim();

      if (!token) {
        throw new Error("KOOK token not configured");
      }

      console.log(`[KOOK-CHANNEL] Token validated successfully`);

      // Probe connection
      const probe = await getKookRuntime().channel.kook.probeKook(token, 5000);
      if (!probe.success) {
        throw new Error(`KOOK probe failed: ${probe.error}`);
      }

      ctx.log?.info("[kook] starting provider...");

      // Start monitoring
      console.log(`[KOOK-CHANNEL] Starting monitorKookProvider with token length: ${token.length}`);
      return getKookRuntime().channel.kook.monitorKookProvider({
        token,
        accountId: ctx.account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: ctx.account.config.mediaMaxMb,
        historyLimit: ctx.account.config.historyLimit,
      });
    },
  },

  /**
   * Setup
   */
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => {
      const kookCfg = (cfg.channels?.kook as Record<string, unknown> | undefined) ?? {};
      const accounts = (kookCfg.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const accountCfg = accounts[accountId] ?? {};

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          kook: {
            ...kookCfg,
            accounts: {
              ...accounts,
              [accountId]: { ...accountCfg, name },
            },
          },
        },
      };
    },
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "KOOK_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "KOOK requires token (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const kookCfg = (cfg.channels?.kook as Record<string, unknown> | undefined) ?? {};
      const accounts = (kookCfg.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const accountCfg = accounts[accountId] ?? {};

      const newAccountCfg: Record<string, unknown> = {
        ...accountCfg,
        enabled: true,
      };

      if (input.token && !input.useEnv) {
        newAccountCfg.token = input.token;
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          kook: {
            ...kookCfg,
            enabled: true,
            accounts: {
              ...accounts,
              [accountId]: newAccountCfg,
            },
          },
        },
      };
    },
  },

  /**
   * Status
   */
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: ({ snapshot }) => {
      const issues: string[] = [];
      if (!snapshot?.configured) {
        issues.push("KOOK not configured");
      }
      if (snapshot?.lastError) {
        issues.push(snapshot.lastError);
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured,
      tokenSource: snapshot.tokenSource,
      running: snapshot.running,
      lastStartAt: snapshot.lastStartAt,
      lastStopAt: snapshot.lastStopAt,
      lastError: snapshot.lastError,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      getKookRuntime().channel.kook.probeKook(account.token, timeoutMs),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
};
