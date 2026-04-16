import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { qqbotBasePluginFields } from "./channel-base.js";
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "./config.js";
import { clearAccountCredentials } from "./engine/config/credentials.js";
import {
  normalizeTarget as coreNormalizeTarget,
  looksLikeQQBotTarget,
} from "./engine/messaging/target-parser.js";
import { getQQBotRuntime } from "./runtime.js";
// Re-export text helpers from engine/.
export { chunkText, TEXT_CHUNK_LIMIT } from "./engine/utils/text-chunk.js";
import type { ResolvedQQBotAccount } from "./types.js";

// Shared promise so concurrent multi-account startups serialize the dynamic
// import of the gateway module, avoiding an ESM circular-dependency race.
let _gatewayModulePromise: Promise<typeof import("./gateway.js")> | undefined;

function loadGatewayModule(): Promise<typeof import("./gateway.js")> {
  _gatewayModulePromise ??= import("./gateway.js");
  return _gatewayModulePromise;
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  ...qqbotBasePluginFields,
  messaging: {
    /** Normalize common QQ Bot target formats into the canonical qqbot:... form. */
    normalizeTarget: coreNormalizeTarget,
    targetResolver: {
      /** Return true when the id looks like a QQ Bot target. */
      looksLikeId: looksLikeQQBotTarget,
      hint: "QQ Bot target format: qqbot:c2c:openid (direct) or qqbot:group:groupid (group)",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getQQBotRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 5000,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendText } = await import("./engine/messaging/outbound.js");
      const result = await sendText({ to, text, accountId, replyToId, account: account as never });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendMedia } = await import("./engine/messaging/outbound.js");
      const result = await sendMedia({
        to,
        text: text ?? "",
        mediaUrl: mediaUrl ?? "",
        accountId,
        replyToId,
        account: account as never,
      });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account } = ctx;
      const { abortSignal, log, cfg } = ctx;
      // Serialize the dynamic import so concurrent multi-account startups
      // do not hit an ESM circular-dependency race where the gateway chunk's
      // transitive imports have not finished evaluating yet.
      const { startGateway } = await loadGatewayModule();

      log?.info(
        `[qqbot:${account.accountId}] Starting gateway — appId=${account.appId}, enabled=${account.enabled}, name=${account.name ?? "unnamed"}`,
      );

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const { nextCfg, cleared, changed } = clearAccountCredentials(
        cfg as unknown as Record<string, unknown>,
        accountId,
      );

      if (changed) {
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as {
          writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
        };
        await configApi.writeConfigFile(nextCfg as OpenClawConfig);
      }

      const resolved = resolveQQBotAccount((changed ? nextCfg : cfg) as OpenClawConfig, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);

      return { ok: true, cleared, envToken, loggedOut };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
};
