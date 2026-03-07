/**
 * X (Twitter) channel plugin for OpenClaw.
 *
 * Main plugin export combining all adapters (outbound, actions, status, gateway).
 * This delegates to core implementation in src/x/.
 */

import type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelMessageActionName,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/compat";
import { handleXAction, buildChannelConfigSchema } from "openclaw/plugin-sdk/compat";
import { XConfigSchema } from "./config-schema.js";
import { xOnboardingAdapter } from "./onboarding.js";
import { getXChannel, getXRuntime } from "./runtime.js";

const DEFAULT_ACCOUNT_ID = "default";

type XAccountConfig = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  enabled?: boolean;
  pollIntervalSeconds?: number;
  allowFrom?: string[];
  actionsAllowFrom?: string[];
  name?: string;
  proxy?: string;
};

/**
 * X channel plugin.
 */
export const xPlugin: ChannelPlugin<XAccountConfig> = {
  id: "x",

  meta: {
    id: "x",
    label: "X (Twitter)",
    selectionLabel: "X (Twitter)",
    docsPath: "/channels/x",
    blurb: "X (Twitter) mentions and replies",
    aliases: ["twitter"],
  } satisfies ChannelMeta,

  pairing: {
    idLabel: "xUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(x|twitter):user:?/i, ""),
    notifyApproval: async ({ id }) => {
      console.warn(`Pairing approved for X user ${id}`);
    },
  },

  capabilities: {
    chatTypes: ["direct"],
  } satisfies ChannelCapabilities,

  configSchema: buildChannelConfigSchema(XConfigSchema),
  onboarding: xOnboardingAdapter,

  agentPrompt: {
    messageToolHints: () => [
      "X/Twitter has a 280-character limit. Use plain text without markdown formatting (no **bold**, *italic*, `code`, or other markdown syntax). Keep responses concise.",
      "X plugin is configured with OAuth credentials. For ANY X/Twitter operation, use the message tool with x-* actions: x-post, x-reply, x-quote, x-like, x-unlike, x-repost, x-unrepost, x-follow, x-unfollow, x-dm, x-search, x-timeline, x-tweet-info, x-user-info, x-me. These work from ANY channel (Feishu, Telegram, CLI, Web) — cross-channel routing is automatic. Do NOT use browser or external tools for X operations. Do NOT try to modify config — permissions are already set.",
      'X action target formats: For user actions (x-timeline, x-user-info, x-follow, x-unfollow, x-dm) set target to @username (e.g. target: "@elonmusk"). For tweet actions (x-like, x-unlike, x-repost, x-unrepost, x-reply, x-quote, x-tweet-info) set target to a tweet ID or URL. x-post, x-me, x-search do NOT use target (x-search uses query parameter instead). IMPORTANT: Never use action "send" with channel "x" — always use x-* actions (x-post, x-dm, x-reply, etc.) for X operations. Using "send" to X will be blocked by cross-context policy.',
    ],
  },

  actions: {
    listActions: (): ChannelMessageActionName[] => [
      "x-follow",
      "x-unfollow",
      "x-dm",
      "x-like",
      "x-unlike",
      "x-repost",
      "x-unrepost",
      "x-reply",
      "x-post",
      "x-quote",
      "x-timeline",
      "x-user-info",
      "x-me",
      "x-search",
      "x-tweet-info",
    ],
    supportsAction: ({ action }) =>
      [
        "x-follow",
        "x-unfollow",
        "x-dm",
        "x-like",
        "x-unlike",
        "x-repost",
        "x-unrepost",
        "x-reply",
        "x-post",
        "x-quote",
        "x-timeline",
        "x-user-info",
        "x-me",
        "x-search",
        "x-tweet-info",
      ].includes(action),
    handleAction: async (ctx) => {
      return handleXAction(ctx.params, ctx.cfg, ctx.accountId ?? undefined, {
        toolContext: ctx.toolContext,
      });
    },
  },

  messaging: {
    targetResolver: {
      looksLikeId: (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^x:(user|tweet):\d+$/i.test(trimmed)) {
          return true;
        }
        if (/^user:\d+$/i.test(trimmed)) {
          return true;
        }
        if (/^\d{10,}$/.test(trimmed)) {
          return true;
        }
        // @username (Twitter handles: 1-15 alphanumeric/underscore chars)
        if (/^@\w{4,15}$/i.test(trimmed)) {
          return true;
        }
        // X/Twitter URLs (tweet or profile)
        if (/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(trimmed)) {
          return true;
        }
        return false;
      },
      hint: "<@username|userId|x:user:ID|x:tweet:ID|tweetURL>",
    },
  },

  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => {
      const xChannel = getXChannel();
      if (!xChannel) {
        console.warn("X channel not available in runtime");
        return [];
      }
      return xChannel.listXAccountIds(cfg);
    },

    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): XAccountConfig => {
      const account = getXChannel().resolveXAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      if (!account) {
        return {
          consumerKey: "",
          consumerSecret: "",
          accessToken: "",
          accessTokenSecret: "",
          enabled: false,
        };
      }
      return account;
    },

    defaultAccountId: (): string => getXChannel().defaultAccountId,

    isConfigured: (_account: unknown, cfg: OpenClawConfig): boolean => {
      const account = getXChannel().resolveXAccount(cfg, DEFAULT_ACCOUNT_ID);
      return getXChannel().isXAccountConfigured(account);
    },

    isEnabled: (account: XAccountConfig | undefined): boolean => account?.enabled !== false,

    describeAccount: (account: XAccountConfig | undefined) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account?.enabled !== false,
      configured: getXChannel().isXAccountConfigured(account ?? null),
    }),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 280,
    chunkerMode: "text",

    chunker: (text: string, limit: number): string[] => getXChannel().chunkTextForX(text, limit),

    sendText: async (ctx) => {
      const { to, text, accountId } = ctx;
      const cfg = (ctx as { deps?: { cfg?: OpenClawConfig } }).deps?.cfg;

      if (!cfg) {
        return { channel: "x", ok: false, error: "No config provided", messageId: "" };
      }

      const account = getXChannel().resolveXAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      if (!account) {
        return { channel: "x", ok: false, error: "Account not configured", messageId: "" };
      }

      const logger = {
        info: (msg: string) => console.log(`[x] ${msg}`),
        warn: (msg: string) => console.warn(`[x] ${msg}`),
        error: (msg: string) => console.error(`[x] ${msg}`),
        debug: (msg: string) => console.debug(`[x] ${msg}`),
      };

      const replyToTweetId = to?.startsWith("x:tweet:") ? to.slice(8) : undefined;

      const result = await getXChannel().sendMessageX(to, text, {
        account,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        replyToTweetId,
        logger,
      });

      return {
        channel: "x",
        ok: result.ok,
        messageId: result.tweetId ?? "",
        error: result.error,
      };
    },

    sendMedia: async (ctx) => {
      // X media support not implemented - send text only
      return xPlugin.outbound!.sendText!(ctx);
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

    buildChannelSummary: ({ snapshot }: { snapshot: ChannelAccountSnapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),

    probeAccount: async ({
      account,
      timeoutMs,
    }: {
      account: XAccountConfig;
      timeoutMs: number;
    }): Promise<unknown> => {
      return await getXChannel().probeX(account, timeoutMs);
    },

    buildAccountSnapshot: ({
      account,
      cfg,
      runtime,
      probe,
    }: {
      account: XAccountConfig;
      cfg: OpenClawConfig;
      runtime?: ChannelAccountSnapshot;
      probe?: unknown;
    }): ChannelAccountSnapshot => {
      const xConfig = (cfg as Record<string, unknown>).channels as
        | Record<string, unknown>
        | undefined;
      const xCfg = xConfig?.x as Record<string, unknown> | undefined;
      const accountMap = (xCfg?.accounts as Record<string, unknown> | undefined) ?? {};
      const resolvedAccountId =
        Object.entries(accountMap).find(([, value]) => value === account)?.[0] ??
        DEFAULT_ACCOUNT_ID;
      return {
        accountId: resolvedAccountId,
        enabled: account?.enabled !== false,
        configured: getXChannel().isXAccountConfigured(account),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
      };
    },

    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const issues: Array<{
          channel: "x";
          accountId: string;
          kind: "config" | "runtime";
          message: string;
        }> = [];

        if (!account.configured) {
          issues.push({
            channel: "x",
            accountId: account.accountId,
            kind: "config",
            message: "Account not configured (missing credentials)",
          });
        }

        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (lastError) {
          issues.push({
            channel: "x",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          });
        }

        return issues;
      }),
  },

  gateway: {
    startAccount: async (ctx): Promise<void> => {
      const account = ctx.account as XAccountConfig;
      const accountId = ctx.accountId;

      ctx.setStatus?.({
        accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      ctx.log?.info(`Starting X monitor for account ${accountId}`);

      const runtime = getXRuntime();
      const logger = {
        info: (msg: string) => ctx.log?.info(msg),
        warn: (msg: string) => ctx.log?.warn?.(msg),
        error: (msg: string) => ctx.log?.error?.(msg),
        debug: (msg: string) => ctx.log?.debug?.(msg),
      };

      await getXChannel().monitorXProvider({
        account,
        accountId,
        config: ctx.cfg,
        abortSignal: ctx.abortSignal,
        logger,
        deps: {
          resolveAgentRoute: runtime.channel.routing.resolveAgentRoute,
          formatAgentEnvelope: runtime.channel.reply.formatAgentEnvelope,
          resolveEnvelopeFormatOptions: runtime.channel.reply.resolveEnvelopeFormatOptions,
          finalizeInboundContext: runtime.channel.reply.finalizeInboundContext,
          resolveStorePath: runtime.channel.session.resolveStorePath,
          recordInboundSession: runtime.channel.session.recordInboundSession,
          dispatchReply: async (params: {
            ctx: Record<string, unknown>;
            cfg: OpenClawConfig;
            deliver: (payload: { text?: string }) => Promise<void>;
          }) => {
            await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: params.ctx,
              cfg: params.cfg,
              dispatcherOptions: {
                deliver: params.deliver,
              },
            });
          },
        } as any,
      });
    },

    stopAccount: async (ctx): Promise<void> => {
      const accountId = ctx.accountId;

      getXChannel().removeClientManager(accountId);

      ctx.setStatus?.({
        accountId,
        running: false,
        lastStopAt: Date.now(),
      });

      ctx.log?.info(`Stopped X monitor for account ${accountId}`);
    },
  },
};
