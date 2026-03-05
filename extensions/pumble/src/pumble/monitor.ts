import type { ChannelAccountSnapshot, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createScopedPairingAccess,
  DEFAULT_GROUP_HISTORY_LIMIT,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveChannelMediaMaxBytes,
  warnMissingProviderGroupPolicyFallbackOnce,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import { getPumbleRuntime } from "../runtime.js";
import type { PumbleAccountConfig } from "../types.js";
import { resolvePumbleAccount } from "./accounts.js";
import { setActivePumbleAddon } from "./active-addon.js";
import { buildPumbleManifest, createPumbleAddon, DEFAULT_WEBHOOK_PORT } from "./addon.js";
import { resolveBotUserId as resolveSharedBotUserId } from "./bot-user-id.js";
import { createPumbleClient, fetchPumbleChannel, fetchPumbleUser } from "./client.js";
import { OcCredentialsStore } from "./credentials.js";
import { syncManifestToServer } from "./manifest-sync.js";
import { resolvePumbleAccessDecision } from "./monitor-auth.js";
import {
  channelKind,
  createDedupeCache,
  isSystemMessage,
  resolveRuntime,
} from "./monitor-helpers.js";
import {
  createHandlePumbleMessage,
  type PumbleNotificationMessageFile,
} from "./monitor-message.js";
import { runWithReconnect } from "./reconnect.js";
import { createPumbleThreadBindingManager } from "./thread-bindings.manager.js";
import { DEFAULT_PUMBLE_THREAD_BINDING_TTL_MS } from "./thread-bindings.types.js";
import { startTunnel } from "./tunnel.js";

/** Subset of pumble-sdk NotificationMessage fields used by the monitor. */
type PumbleNotificationMessage = {
  mId: string;
  wId: string;
  cId: string;
  trId: string;
  aId: string;
  tx: string;
  tsm: number;
  eph: boolean;
  /** Event type (e.g. "NEW_MESSAGE") — always present, not a system indicator. */
  ty?: string;
  /** System message flag — `true` for join/leave/topic-change/etc. */
  sys?: boolean;
  /** File attachments included in the message. */
  f?: PumbleNotificationMessageFile[];
};

/** Subset of pumble-sdk NotificationReaction fields. */
type PumbleNotificationReaction = {
  wId: string;
  cId: string;
  mId: string;
  uId: string;
  rc: string; // emoji code
  ty: string; // reaction type
};

export type MonitorPumbleOpts = {
  botToken?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const USER_CACHE_TTL_MS = 10 * 60_000;
const CHANNEL_CACHE_TTL_MS = 5 * 60_000;

function resolvePumbleThreadBindingTtlMs(config: PumbleAccountConfig): number {
  const hours = config.threadBindings?.ttlHours;
  if (typeof hours === "number" && Number.isFinite(hours) && hours > 0) {
    return Math.floor(hours * 60 * 60 * 1000);
  }
  return DEFAULT_PUMBLE_THREAD_BINDING_TTL_MS;
}

/**
 * Pumble HTTP webhook event listener with reconnection.
 *
 * Starts an Express server (via pumble-sdk) to receive webhook events from
 * Pumble, using localtunnel (or a static URL) for public HTTPS access.
 * Wrapped with exponential backoff (`runWithReconnect`) for tunnel recovery.
 */
export async function monitorPumbleProvider(opts: MonitorPumbleOpts = {}): Promise<void> {
  const core = getPumbleRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolvePumbleAccount({
    cfg,
    accountId: opts.accountId,
  });
  const pairing = createScopedPairingAccess({
    core,
    channel: "pumble",
    accountId: account.accountId,
  });
  const botToken = opts.botToken?.trim() || account.botToken?.trim();
  if (!botToken) {
    throw new Error(
      `Pumble bot token missing for account "${account.accountId}" (set channels.pumble.accounts.${account.accountId}.botToken or PUMBLE_BOT_TOKEN for default).`,
    );
  }

  const logger = core.logging.getChildLogger({ module: "pumble" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };

  runtime.log?.(`pumble: starting monitor for account "${account.accountId}"`);
  opts.statusSink?.({ running: true });

  // Initialize thread binding manager for subagent thread routing
  createPumbleThreadBindingManager({
    accountId: account.accountId,
    botToken,
    appKey: account.appKey?.trim(),
    persist: true,
    enableSweeper: true,
    sessionTtlMs: resolvePumbleThreadBindingTtlMs(account.config),
  });

  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.pumble !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "pumble",
    accountId: account.accountId,
    log: (message) => logVerboseMessage(message),
  });

  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg,
    resolveChannelLimitMb: () => undefined,
    accountId: account.accountId,
  });

  const recentInboundMessages = createDedupeCache({
    ttlMs: RECENT_MESSAGE_TTL_MS,
    maxSize: RECENT_MESSAGE_MAX,
  });

  // Shared client for the monitor lifetime — avoids rebuilding per cache-miss.
  const sharedClient = createPumbleClient({ botToken, appKey: account.appKey?.trim() });

  const userCache = new Map<
    string,
    { value: { name?: string; email?: string } | null; expiresAt: number }
  >();

  // Bot user ID resolved via the shared helper (config → JWT → /oauth2/me).
  // Three-state sentinel: null = unresolved, undefined = resolved-but-absent, string = cached name.
  let cachedBotUsername: string | undefined | null = null;
  const resolveBotId = async (): Promise<string | null> => {
    const userId = await resolveSharedBotUserId({
      accountId: account.accountId,
      botToken,
      appKey: account.appKey?.trim(),
      explicitBotUserId: account.config.botUserId,
    });
    if (!userId) {
      runtime.log?.(
        `pumble: warning: could not resolve bot user ID — self-message filtering disabled. ` +
          `Set channels.pumble.botUserId in config (value from tokens.json botId field).`,
      );
    }
    return userId;
  };
  const resolveBotUsername = async (): Promise<string | undefined> => {
    if (cachedBotUsername !== null) {
      return cachedBotUsername;
    }
    const botId = await resolveBotId();
    if (botId) {
      const name = await resolveSenderName(botId);
      cachedBotUsername = name ?? undefined;
      return cachedBotUsername;
    }
    cachedBotUsername = undefined;
    return undefined;
  };

  // Channel type cache with TTL (5 minutes).
  const channelTypeCache = new Map<string, { value: string; expiresAt: number }>();

  const resolveChannelType = async (channelId: string): Promise<string | undefined> => {
    const now = Date.now();
    const cached = channelTypeCache.get(channelId);
    if (cached && cached.expiresAt > now) {
      logVerboseMessage(
        `pumble: channelType cache HIT for ${channelId} (type=${cached.value}, ttl=${Math.round((cached.expiresAt - now) / 1000)}s remaining)`,
      );
      return cached.value;
    }
    try {
      logVerboseMessage(`pumble: channelType cache MISS for ${channelId} — fetching from API`);
      const ch = await fetchPumbleChannel(sharedClient, channelId);
      // Pumble API returns `channelType` in v1 responses; `type` is a legacy
      // field observed in some older SDK versions. Kept as fallback.
      const chType = ch.channelType ?? ch.type;
      if (chType) {
        channelTypeCache.set(channelId, {
          value: chType,
          expiresAt: now + CHANNEL_CACHE_TTL_MS,
        });
        return chType;
      }
    } catch {
      // Non-fatal — channelKind() defaults to "channel" when type is undefined.
    }
    return undefined;
  };

  const resolveSenderName = async (senderId: string): Promise<string | undefined> => {
    const now = Date.now();
    const cached = userCache.get(senderId);
    if (cached && cached.expiresAt > now) {
      return cached.value?.name;
    }
    try {
      const user = await fetchPumbleUser(sharedClient, senderId);
      const name = user.displayName || user.name;
      userCache.set(senderId, {
        value: { name, email: user.email },
        expiresAt: now + USER_CACHE_TTL_MS,
      });
      return name;
    } catch {
      return undefined;
    }
  };

  const handlePumbleMessage = createHandlePumbleMessage({
    core,
    account,
    botToken,
    cfg,
    runtime,
    groupPolicy,
    historyLimit,
    channelHistories,
    mediaMaxBytes,
    logVerboseMessage,
    logger,
    resolveBotId,
    resolveBotUsername,
    pairing,
    statusSink: opts.statusSink,
    recentInboundMessages,
  });

  /** Shared access-decision + routing pipeline for lightweight event handlers. */
  const resolveAccessAndRoute = async (params: {
    senderId: string;
    channelId: string;
    eventLabel: string;
  }) => {
    const botId = await resolveBotId();
    if (botId && params.senderId === botId) {
      return null;
    }
    const channelType = await resolveChannelType(params.channelId);
    const kind = channelKind(channelType);
    const senderName = (await resolveSenderName(params.senderId)) ?? params.senderId;
    const accessDecision = await resolvePumbleAccessDecision({
      accountConfig: account.config,
      accountId: account.accountId,
      readStoreForDmPolicy: pairing.readStoreForDmPolicy,
      kind,
      groupPolicy,
      senderId: params.senderId,
      senderName,
    });
    if (accessDecision.decision !== "allow") {
      logVerboseMessage(
        `pumble: drop ${params.eventLabel} (${kind === "direct" ? `dmPolicy=${accessDecision.dmPolicy}` : `groupPolicy=${groupPolicy}`} sender=${params.senderId})`,
      );
      return null;
    }
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "pumble",
      accountId: account.accountId,
      peer: { kind, id: kind === "direct" ? params.senderId : params.channelId },
    });
    return { kind, senderName, route };
  };

  const handlePumbleReactionEvent = async (body: PumbleNotificationReaction) => {
    const userId = body.uId?.trim();
    const messageId = body.mId?.trim();
    const emojiRaw = body.rc?.trim();
    const channelId = body.cId?.trim();
    if (!userId || !messageId || !emojiRaw || !channelId) {
      return;
    }
    const resolved = await resolveAccessAndRoute({
      senderId: userId,
      channelId,
      eventLabel: "reaction",
    });
    if (!resolved) return;

    const emoji = emojiRaw.replace(/^:/, "").replace(/:$/, "");
    const eventText = `Pumble reaction added: :${emoji}: by @${resolved.senderName} on message ${messageId} in channel ${channelId}`;
    core.system.enqueueSystemEvent(eventText, {
      sessionKey: resolved.route.sessionKey,
      contextKey: `pumble:reaction:${messageId}:${emoji}:${userId}:added`,
    });
    logVerboseMessage(
      `pumble reaction: added :${emoji}: by ${resolved.senderName} on ${messageId}`,
    );
  };

  const handlePumbleUpdatedMessage = async (body: PumbleNotificationMessage) => {
    const channelId = body.cId?.trim();
    const senderId = body.aId?.trim();
    const messageId = body.mId?.trim();
    if (!channelId || !senderId || !messageId) {
      return;
    }
    const resolved = await resolveAccessAndRoute({
      senderId,
      channelId,
      eventLabel: "updated message",
    });
    if (!resolved) return;

    const channelLabel =
      resolved.kind === "direct" ? `DM with ${resolved.senderName}` : `#${channelId}`;
    const eventText = `Pumble message edited by @${resolved.senderName} in ${channelLabel}`;
    core.system.enqueueSystemEvent(eventText, {
      sessionKey: resolved.route.sessionKey,
      contextKey: `pumble:message:changed:${channelId}:${messageId}`,
    });
    logVerboseMessage(
      `pumble message edited: by ${resolved.senderName} in ${channelLabel} (${messageId})`,
    );
  };

  // Check if SDK credentials are available for webhook mode.
  const canUseSDK = !!(
    account.appId?.trim() &&
    account.appKey?.trim() &&
    account.clientSecret?.trim() &&
    account.signingSecret?.trim()
  );

  if (canUseSDK) {
    // --- HTTP webhook path with reconnection ---
    const webhookPort = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
    const staticWebhookUrl = account.config.webhookUrl?.trim() || undefined;

    const registerHandlers = (addon: ReturnType<typeof createPumbleAddon>) => {
      // Register NEW_MESSAGE handler — maps NotificationMessage → handlePumbleMessage
      addon.message("NEW_MESSAGE", { match: /.*/, includeBotMessages: false }, async (ctx) => {
        const body = ctx.payload.body as PumbleNotificationMessage;

        // Filter system messages before any processing
        if (isSystemMessage(body.sys)) {
          logVerboseMessage(`pumble: drop system message`);
          return;
        }

        const channelType = await resolveChannelType(body.cId);
        const senderName = await resolveSenderName(body.aId);

        await handlePumbleMessage({
          messageId: body.mId,
          channelId: body.cId,
          channelType,
          senderId: body.aId,
          senderName,
          text: body.tx,
          threadRootId: body.trId && body.trId !== "" ? body.trId : undefined,
          timestamp: body.tsm || undefined,
          isEphemeral: body.eph,
          isSystem: body.sys,
          files: body.f,
        });
      });

      // Register REACTION_ADDED handler
      addon.reaction(/.*/, async (ctx) => {
        const body = ctx.payload.body as unknown as PumbleNotificationReaction;
        await handlePumbleReactionEvent(body);
      });

      // Register UPDATED_MESSAGE handler — lightweight edit notification (no reply dispatch)
      addon.message("UPDATED_MESSAGE", { match: /.*/, includeBotMessages: false }, async (ctx) => {
        const body = ctx.payload.body as PumbleNotificationMessage;
        await handlePumbleUpdatedMessage(body);
      });

      addon.onError((err) => {
        runtime.error?.(`pumble sdk error: ${String(err.error)}`);
      });
    };

    // Each reconnect iteration opens a tunnel, syncs the manifest, then starts
    // the Express server. On failure or abort the tunnel is closed.
    const connectOnce = async (): Promise<void> => {
      const tunnel = await startTunnel(webhookPort, staticWebhookUrl);
      const webhookBaseUrl = tunnel.url;
      runtime.log?.(`pumble: tunnel open at ${webhookBaseUrl}`);

      // Declared outside try so the finally block can close the HTTP server
      // to free the port for reconnection (pumble-sdk has no stop() method).
      let httpServer: import("http").Server | undefined;

      try {
        // Sync webhook URLs to Pumble server
        const manifest = buildPumbleManifest(account, webhookBaseUrl);
        await syncManifestToServer(manifest, (msg) => runtime.log?.(msg));

        // Create addon in HTTP mode
        const store = new OcCredentialsStore(account.accountId, account);
        const addon = createPumbleAddon(account, store, {
          webhookBaseUrl,
          port: webhookPort,
        });

        // Capture the underlying HTTP server by intercepting Express listen().
        // pumble-sdk does not expose getHttpServer() or a stop() method, so we
        // intercept listen() on the Express instance to grab the http.Server
        // reference for clean shutdown. This is instance-level patching (not
        // prototype mutation) and is the only way to free the port on reconnect.
        addon.onServerConfiguring((expressApp) => {
          const origListen = (
            expressApp as { listen: (...args: unknown[]) => import("http").Server }
          ).listen.bind(expressApp);
          (expressApp as { listen: (...args: unknown[]) => import("http").Server }).listen = (
            ...args: unknown[]
          ) => {
            httpServer = origListen(...args);
            return httpServer!;
          };
        });

        registerHandlers(addon);

        // Close tunnel on abort
        const onAbort = () => tunnel.close();
        opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

        opts.statusSink?.({ connected: true, lastConnectedAt: Date.now() });
        runtime.log?.(
          `pumble: HTTP webhook server starting on port ${webhookPort} for account "${account.accountId}"`,
        );

        // Start the Express server (resolves once listening).
        await addon.start();

        // Defensive: if the Express listen() patch didn't capture the server,
        // the port won't be freed on reconnect. Log a warning so operators know.
        // TODO: upstream pumble-sdk issue for addon.getHttpServer() or addon.stop()
        if (!httpServer) {
          runtime.log?.(
            `pumble: warning: could not capture HTTP server reference — port ${webhookPort} may not be freed on reconnect`,
          );
        }

        // Register active addon so send.ts can use the SDK bot client for media uploads.
        const addonWorkspaceId = account.workspaceId || account.accountId;
        setActivePumbleAddon(addon, addonWorkspaceId, account.accountId);

        runtime.log?.(
          `pumble: HTTP webhook server listening on port ${webhookPort} — waiting for events`,
        );

        // Keep alive until tunnel dies or abort fires.
        // addon.start() resolves immediately after Express binds, so we
        // need a separate hold promise to prevent connectOnce from returning.
        await Promise.race([
          tunnel.died.then((err) => {
            throw new Error(`tunnel lost: ${err.message}`);
          }),
          new Promise<void>((resolve) => {
            if (opts.abortSignal?.aborted) {
              resolve();
              return;
            }
            opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);

        opts.abortSignal?.removeEventListener("abort", onAbort);
        opts.statusSink?.({ connected: false });
      } finally {
        setActivePumbleAddon(null, "", account.accountId);
        // Close the Express HTTP server to free the port for reconnection.
        if (httpServer) {
          httpServer.close();
          httpServer.closeAllConnections?.();
        }
        tunnel.close();
      }
    };

    await runWithReconnect(connectOnce, {
      abortSignal: opts.abortSignal,
      jitterRatio: 0.2,
      onError: (err) => {
        runtime.error?.(`pumble: webhook server failed: ${String(err)}`);
        opts.statusSink?.({ connected: false, lastError: String(err) });
      },
      onReconnect: (delayMs) => {
        runtime.log?.(`pumble: reconnecting in ${Math.round(delayMs / 1000)}s`);
      },
    });

    opts.statusSink?.({ running: false, connected: false, lastStopAt: Date.now() });
    return;
  }

  // --- REST-only fallback (no SDK credentials) ---
  runtime.log?.(`pumble: SDK credentials missing, running in REST-only mode`);

  // Keep the monitor alive until aborted
  return new Promise<void>((resolve) => {
    if (opts.abortSignal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      opts.statusSink?.({ running: false, connected: false, lastStopAt: Date.now() });
      resolve();
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
