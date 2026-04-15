import { ChannelMessageActionAdapter } from "openclaw/plugin-sdk";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { startYuanbaoWsGateway } from "./access/ws/index.js";
import {
  listYuanbaoAccountIds,
  resolveDefaultYuanbaoAccountId,
  resolveYuanbaoAccount,
} from "./accounts.js";
import { handleAction, yuanbaoMessageActions } from "./business/actions/index.js";
import type { ActionParams } from "./business/actions/resolve-target.js";
import { normalizeTarget, buildMessageToolHints } from "./business/messaging/targets.js";
import { yuanbaoConfigSchema } from "./config-schema.js";
import { createLog, setDebugBotIds } from "./logger.js";
import { getYuanbaoRuntime } from "./runtime.js";
import { yuanbaoSetupAdapter } from "./setup.js";
// import { yuanbaoOnboardingAdapter } from './onboarding.js';
import type { ResolvedYuanbaoAccount } from "./types.js";

// ============ Metadata ============
const meta = {
  id: "yuanbao",
  label: "元宝 Bot",
  selectionLabel: "元宝 Bot (yuanbao)",
  detailLabel: "元宝 Bot",
  docsPath: "/channels/yuanbao",
  docsLabel: "yuanbao",
  blurb: "YuanBao bot via WebSocket.",
  aliases: ["yuanbao", "元宝", "即时通信"],
  order: 85,
  quickstartAllowFrom: true,
};

/**
 * Main channel plugin definition object, built using the createChatChannelPlugin factory function
 */
export const yuanbaoPlugin: ChannelPlugin<ResolvedYuanbaoAccount> = createChatChannelPlugin({
  base: {
    id: "yuanbao",
    meta,
    // onboarding: yuanbaoOnboardingAdapter,
    setup: yuanbaoSetupAdapter,
    actions: yuanbaoMessageActions as ChannelMessageActionAdapter,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      reactions: true,
      threads: false,
      polls: false,
      nativeCommands: true,
    },
    reload: { configPrefixes: ["channels.yuanbao"] },
    configSchema: yuanbaoConfigSchema,
    config: {
      listAccountIds: (cfg) => listYuanbaoAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveYuanbaoAccount({ cfg: cfg, accountId }),
      defaultAccountId: (cfg) => resolveDefaultYuanbaoAccountId(cfg),
      setAccountEnabled: ({ cfg, accountId, enabled }) =>
        setAccountEnabledInConfigSection({
          cfg: cfg,
          sectionKey: "yuanbao",
          accountId,
          enabled,
          allowTopLevel: true,
        }),
      deleteAccount: ({ cfg, accountId }) =>
        deleteAccountFromConfigSection({
          cfg: cfg,
          sectionKey: "yuanbao",
          clearBaseFields: [
            "name",
            "appKey",
            "appSecret",
            "token",
            "overflowPolicy",
            "replyToMode",
            "outboundQueueStrategy",
            "mediaMaxMb",
            "historyLimit",
            "disableBlockStreaming",
            "fallbackReply",
          ],
          accountId,
        }),
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        tokenStatus: account.configured ? "available" : "missing",
      }),
      resolveAllowFrom: ({ cfg, accountId }) => {
        const account = resolveYuanbaoAccount({ cfg: cfg, accountId });
        return (account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
      },
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom
          .map((entry) => String(entry).trim())
          .filter(Boolean)
          .map((entry) => entry.toLowerCase()),
    },
    groups: {
      resolveRequireMention: () => true,
    },
    messaging: {
      normalizeTarget,
      targetResolver: {
        looksLikeId: (raw) => Boolean(raw.trim()),
        hint: "<userId> or group:<groupCode>",
      },
    },
    agentPrompt: {
      messageToolHints() {
        return buildMessageToolHints();
      },
    },

    // Configure the OpenClaw built-in block-streaming coalescer:
    // Deliver only after 2800 characters or 1s idle
    streaming: {
      blockStreamingCoalesceDefaults: {
        minChars: 2800,
        idleMs: 1000,
      },
    },

    status: createComputedAccountStatusAdapter<ResolvedYuanbaoAccount>({
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
        onfigured: snapshot.configured ?? false,
        tokenSource: snapshot.tokenSource ?? "none",
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
        lastError: snapshot.lastError ?? null,
      }),
      probeAccount: async () => ({ ok: true }),
      resolveAccountSnapshot: ({ account, runtime: _runtime }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        name: account.name,
        extra: {
          // Framework uses tokenStatus to determine channel status; missing this field causes "no token" + SETUP
          tokenStatus: account.configured ? "available" : "missing",
          // token is only set when user explicitly configures a static token; in normal ticket-signing mode token is undefined
          ...(account.token ? { token: account.token } : {}),
          dmPolicy: account.config.dm?.policy ?? "open",
        },
      }),
    }),

    gateway: {
      startAccount: async (ctx) => {
        const { account } = ctx;
        const slog = createLog("gateway", ctx.log);

        slog.debug("starting account", account as unknown as Record<string, unknown>);

        if (!account.configured) {
          slog.warn("yuanbao not configured; skipping");
          ctx.setStatus({ accountId: account.accountId, running: false, configured: false });
          return;
        }

        // Initialize debug whitelist
        const yuanbaoTopConfig = ctx.cfg.channels?.yuanbao as
          | import("./types.js").YuanbaoConfig
          | undefined;
        if (yuanbaoTopConfig?.debugBotIds?.length) {
          setDebugBotIds(yuanbaoTopConfig.debugBotIds);
        }

        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          configured: true,
          lastStartAt: Date.now(),
        });

        return startYuanbaoWsGateway({
          account,
          config: ctx.cfg,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
          runtime: getYuanbaoRuntime(),
          statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
        });
      },
      stopAccount: async (ctx) => {
        // Outbound queue lifecycle is managed by pipeline middleware; no global destruction needed
        ctx.setStatus({
          accountId: ctx.account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      },
    },
  },

  // Use createScopedDmSecurityResolver to simplify DM security policy resolution
  security: {
    resolveDmPolicy: createScopedDmSecurityResolver<ResolvedYuanbaoAccount>({
      channelKey: "yuanbao",
      resolvePolicy: (account) => account.config.dm?.policy,
      resolveAllowFrom: (account) => account.config.dm?.allowFrom,
      defaultPolicy: "open",
      normalizeEntry: (raw) => raw.trim().toLowerCase(),
    }),
  },

  // Group chat reply-to strategy
  threading: {
    resolveReplyToMode: () => "all",
  },

  // Outbound message configuration
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 3000,
    chunker: (text, limit) =>
      getYuanbaoRuntime()?.channel.text.chunkMarkdownText(text, limit) ?? [text],
    sendText: async (params) => {
      const slog = createLog("channel.outbound");
      const { accountId, to } = params;
      slog.info("sendText", { accountId, to });
      try {
        await handleAction(params as unknown as ActionParams);
        return { channel: "yuanbao", ok: true, messageId: "" };
      } catch (err) {
        slog.error("outbound.sendText error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          channel: "yuanbao",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    sendMedia: async (params) => {
      const slog = createLog("channel.outbound");
      const { accountId, to } = params;
      slog.info("sendMedia", { accountId, to });
      try {
        await handleAction(params as unknown as ActionParams);
        return { channel: "yuanbao", ok: true, messageId: "" };
      } catch (err) {
        slog.error("outbound.sendMedia error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          channel: "yuanbao",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },
});
