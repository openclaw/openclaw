import type { BskyAgent } from "@atproto/api";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/channel-plugin-common";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  listBlueskyAccountIds,
  resolveBlueskyAccount,
  resolveDefaultBlueskyAccountId,
} from "./accounts.js";
import { evictChatServiceTokens, loginBluesky } from "./auth.js";
import { dispatchBlueskyInboundTurn } from "./inbound-turn.js";
import { runBlueSkyPollLoop } from "./poll.js";
import { setBlueskyRuntime } from "./runtime.js";
import { sendBlueskyMessage } from "./send.js";
import type { ResolvedBlueskyAccount } from "./types.js";

export { setBlueskyRuntime };

const CHANNEL_ID = "bluesky";

/**
 * Active agents keyed by accountId.
 * Stored here so the outbound adapter can access them without going through gateway context.
 */
const activeAgents = new Map<string, BskyAgent>();

export const blueskyPlugin: ChannelPlugin<ResolvedBlueskyAccount> = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "Bluesky",
    selectionLabel: "Bluesky (DMs)",
    detailLabel: "Bluesky DM",
    docsPath: "/channels/bluesky",
    blurb: "Connect OpenClaw to Bluesky DMs via the AT Protocol chat API.",
    order: 85,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },

  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  config: {
    listAccountIds: (cfg) => listBlueskyAccountIds(cfg as Record<string, unknown>),

    resolveAccount: (cfg, accountId) =>
      resolveBlueskyAccount(cfg as Record<string, unknown>, accountId),

    defaultAccountId: (cfg) => resolveDefaultBlueskyAccountId(cfg as Record<string, unknown>),

    isConfigured: (account) => account.configured,

    describeAccount: (account) => ({
      accountId: account.accountId,
      handle: account.handle,
      pdsUrl: account.pdsUrl,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log } = ctx;

      if (!account.configured) {
        throw new Error(
          `Bluesky is not configured for account "${account.accountId}" — set channels.bluesky.handle and channels.bluesky.appPassword`,
        );
      }

      log?.info?.(`Bluesky [${account.accountId}]: logging in as ${account.handle}`);

      let agent: BskyAgent;
      try {
        agent = await loginBluesky({
          handle: account.handle,
          appPassword: account.appPassword,
          pdsUrl: account.pdsUrl,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.error?.(`Bluesky [${account.accountId}]: login failed — ${msg}`);
        throw err;
      }

      const selfDid = agent.session?.did ?? "";
      logVerbose(`Bluesky [${account.accountId}]: authenticated as ${selfDid}`);
      activeAgents.set(account.accountId, agent);

      await runBlueSkyPollLoop({
        agent,
        selfDid,
        abortSignal,
        callbacks: {
          onMessage: async (msg) => {
            // Re-read config each turn so live config changes take effect
            const rt = (await import("./runtime.js")).getBlueskyRuntime();
            const currentCfg = rt.config.loadConfig();
            await dispatchBlueskyInboundTurn({
              account,
              agent,
              msg,
              cfg: currentCfg,
              log,
            });
          },
          onError: (err, context) => {
            log?.error?.(`Bluesky [${account.accountId}]: error in ${context} — ${err.message}`);
          },
        },
      });
    },

    stopAccount: async (ctx) => {
      const agent = activeAgents.get(ctx.account.accountId);
      if (agent?.session?.did) {
        evictChatServiceTokens(agent.session.did);
      }
      activeAgents.delete(ctx.account.accountId);
      ctx.log?.info?.(`Bluesky [${ctx.account.accountId}]: stopped`);
    },
  },

  outbound: {
    deliveryMode: "direct",

    sendText: async ({ to, text, accountId }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const agent = activeAgents.get(resolvedAccountId);
      if (!agent) {
        throw new Error(
          `Bluesky: no active session for account "${resolvedAccountId}" — is the gateway running?`,
        );
      }
      const { convoId, messageId } = await sendBlueskyMessage(agent, to, text);
      return { channel: CHANNEL_ID, to: convoId, messageId };
    },
  },
};
