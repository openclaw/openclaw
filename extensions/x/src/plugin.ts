/**
 * X (Twitter) channel plugin for OpenClaw.
 *
 * Main plugin export combining all adapters (outbound, actions, status, gateway).
 * This delegates to core implementation in src/x/.
 */

import type { OpenClawConfig } from "../../../src/plugin-sdk/index.js";
import { buildChannelConfigSchema } from "../../../src/plugin-sdk/index.js";
import { XConfigSchema } from "./config-schema.js";
import { getXRuntime } from "./runtime.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";
import type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
} from "../../../src/channels/plugins/types.core.js";

const DEFAULT_ACCOUNT_ID = "default";

type XAccountConfig = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  enabled?: boolean;
  pollIntervalSeconds?: number;
  allowFrom?: string[];
  name?: string;
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

  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] =>
      getXRuntime().channel.x.listXAccountIds(cfg),

    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): XAccountConfig => {
      const account = getXRuntime().channel.x.resolveXAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
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

    defaultAccountId: (): string =>
      getXRuntime().channel.x.defaultAccountId,

    isConfigured: (_account: unknown, cfg: OpenClawConfig): boolean => {
      const account = getXRuntime().channel.x.resolveXAccount(cfg, DEFAULT_ACCOUNT_ID);
      return getXRuntime().channel.x.isXAccountConfigured(account);
    },

    isEnabled: (account: XAccountConfig | undefined): boolean => account?.enabled !== false,

    describeAccount: (account: XAccountConfig | undefined) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account?.enabled !== false,
      configured: getXRuntime().channel.x.isXAccountConfigured(account ?? null),
    }),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 280,
    chunkerMode: "text",

    chunker: (text: string, limit: number): string[] =>
      getXRuntime().channel.x.chunkTextForX(text, limit),

    sendText: async (ctx) => {
      const { to, text, accountId } = ctx;
      const cfg = (ctx as { deps?: { cfg?: OpenClawConfig } }).deps?.cfg;

      if (!cfg) {
        return { channel: "x", ok: false, error: "No config provided", messageId: "" };
      }

      const account = getXRuntime().channel.x.resolveXAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
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

      const result = await getXRuntime().channel.x.sendMessageX(to, text, {
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
      return await getXRuntime().channel.x.probeX(account, timeoutMs);
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
        configured: getXRuntime().channel.x.isXAccountConfigured(account),
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

      await runtime.channel.x.monitorXProvider({
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
          dispatchReply: async (params) => {
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

      getXRuntime().channel.x.removeClientManager(accountId);

      ctx.setStatus?.({
        accountId,
        running: false,
        lastStopAt: Date.now(),
      });

      ctx.log?.info(`Stopped X monitor for account ${accountId}`);
    },
  },
};
