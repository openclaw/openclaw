import { format } from "node:util";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type RuntimeEnv,
} from "../../runtime-api.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig, ReplyToMode } from "../../types.js";
import { resolveConfiguredMatrixBotUserIds, resolveMatrixAccount } from "../accounts.js";
import { setActiveMatrixClient } from "../active-client.js";
import {
  isBunRuntime,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  resolveSharedMatrixClient,
} from "../client.js";
import { releaseSharedClientInstance } from "../client/shared.js";
import { createMatrixThreadBindingManager } from "../thread-bindings.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { resolveMatrixMonitorConfig } from "./config.js";
import { createDirectRoomTracker } from "./direct.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";
import { runMatrixStartupMaintenance } from "./startup.js";

export type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
  accountId?: string | null;
};

const DEFAULT_MEDIA_MAX_MB = 20;

export async function monitorMatrixProvider(opts: MonitorMatrixOpts = {}): Promise<void> {
  if (isBunRuntime()) {
    throw new Error("Matrix provider requires Node (bun runtime not supported)");
  }
  const core = getMatrixRuntime();
  let cfg = core.config.loadConfig() as CoreConfig;
  if (cfg.channels?.["matrix"]?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "matrix-auto-reply" });
  const formatRuntimeMessage = (...args: Parameters<RuntimeEnv["log"]>) => format(...args);
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => {
      logger.info(formatRuntimeMessage(...args));
    },
    error: (...args) => {
      logger.error(formatRuntimeMessage(...args));
    },
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };

  const authContext = resolveMatrixAuthContext({
    cfg,
    accountId: opts.accountId,
  });
  const effectiveAccountId = authContext.accountId;

  // Resolve account-specific config for multi-account support
  const account = resolveMatrixAccount({ cfg, accountId: effectiveAccountId });
  const accountConfig = account.config;

  const allowlistOnly = accountConfig.allowlistOnly === true;
  const accountAllowBots = accountConfig.allowBots;
  let allowFrom: string[] = (accountConfig.dm?.allowFrom ?? []).map(String);
  let groupAllowFrom: string[] = (accountConfig.groupAllowFrom ?? []).map(String);
  let roomsConfig = accountConfig.groups ?? accountConfig.rooms;
  let needsRoomAliasesForConfig = false;
  const configuredBotUserIds = resolveConfiguredMatrixBotUserIds({
    cfg,
    accountId: effectiveAccountId,
  });

  ({ allowFrom, groupAllowFrom, roomsConfig } = await resolveMatrixMonitorConfig({
    cfg,
    accountId: effectiveAccountId,
    allowFrom,
    groupAllowFrom,
    roomsConfig,
    runtime,
  }));
  needsRoomAliasesForConfig = Boolean(
    roomsConfig && Object.keys(roomsConfig).some((key) => key.trim().startsWith("#")),
  );

  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.["matrix"],
        dm: {
          ...cfg.channels?.["matrix"]?.dm,
          allowFrom,
        },
        groupAllowFrom,
        ...(roomsConfig ? { groups: roomsConfig } : {}),
      },
    },
  };

  const auth = await resolveMatrixAuth({ cfg, accountId: effectiveAccountId });
  const resolvedInitialSyncLimit =
    typeof opts.initialSyncLimit === "number"
      ? Math.max(0, Math.floor(opts.initialSyncLimit))
      : auth.initialSyncLimit;
  const authWithLimit =
    resolvedInitialSyncLimit === auth.initialSyncLimit
      ? auth
      : { ...auth, initialSyncLimit: resolvedInitialSyncLimit };
  const client = await resolveSharedMatrixClient({
    cfg,
    auth: authWithLimit,
    startClient: false,
    accountId: auth.accountId,
  });
  setActiveMatrixClient(client, auth.accountId);
  let cleanedUp = false;
  let threadBindingManager: { accountId: string; stop: () => void } | null = null;
  const inboundDeduper = await createMatrixInboundEventDeduper({
    auth,
    env: process.env,
  });
  const inFlightRoomMessages = new Set<Promise<void>>();
  const waitForInFlightRoomMessages = async () => {
    while (inFlightRoomMessages.size > 0) {
      await Promise.allSettled(Array.from(inFlightRoomMessages));
    }
  };
  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      client.stopSyncWithoutPersist();
      await client.drainPendingDecryptions("matrix monitor shutdown");
      await waitForInFlightRoomMessages();
      threadBindingManager?.stop();
      await inboundDeduper.stop();
      await releaseSharedClientInstance(client, "persist");
    } finally {
      setActiveMatrixClient(null, auth.accountId);
    }
  };

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy: groupPolicyRaw, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.["matrix"] !== undefined,
      groupPolicy: accountConfig.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "matrix",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => logVerboseMessage(message),
  });
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? accountConfig.replyToMode ?? "off";
  const threadReplies = accountConfig.threadReplies ?? "inbound";
  const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg,
    channel: "matrix",
    accountId: account.accountId,
  });
  const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg,
    channel: "matrix",
    accountId: account.accountId,
  });
  const dmConfig = accountConfig.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "matrix", account.accountId);
  const mediaMaxMb = opts.mediaMaxMb ?? accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const startupMs = Date.now();
  const startupGraceMs = 0;
  // Cold starts should ignore old room history, but once we have a persisted
  // /sync cursor we want restart backlogs to replay just like other channels.
  const dropPreStartupMessages = !client.hasPersistedSyncState();
  const directTracker = createDirectRoomTracker(client, { log: logVerboseMessage });
  registerMatrixAutoJoin({ client, accountConfig, runtime });
  const warnedEncryptedRooms = new Set<string>();
  const warnedCryptoMissingRooms = new Set<string>();

  const { getRoomInfo, getMemberDisplayName } = createMatrixRoomInfoResolver(client);
  const handleRoomMessage = createMatrixRoomMessageHandler({
    client,
    core,
    cfg,
    accountId: account.accountId,
    runtime,
    logger,
    logVerboseMessage,
    allowFrom,
    groupAllowFrom,
    roomsConfig,
    accountAllowBots,
    configuredBotUserIds,
    mentionRegexes,
    groupPolicy,
    replyToMode,
    threadReplies,
    dmEnabled,
    dmPolicy,
    textLimit,
    mediaMaxBytes,
    startupMs,
    startupGraceMs,
    dropPreStartupMessages,
    inboundDeduper,
    directTracker,
    getRoomInfo,
    getMemberDisplayName,
    needsRoomAliasesForConfig,
  });
  const trackRoomMessage = (roomId: string, event: Parameters<typeof handleRoomMessage>[1]) => {
    const task = Promise.resolve(handleRoomMessage(roomId, event)).finally(() => {
      inFlightRoomMessages.delete(task);
    });
    inFlightRoomMessages.add(task);
    return task;
  };

  try {
    threadBindingManager = await createMatrixThreadBindingManager({
      accountId: account.accountId,
      auth,
      client,
      env: process.env,
      idleTimeoutMs: threadBindingIdleTimeoutMs,
      maxAgeMs: threadBindingMaxAgeMs,
      logVerboseMessage,
    });
    logVerboseMessage(
      `matrix: thread bindings ready account=${threadBindingManager.accountId} idleMs=${threadBindingIdleTimeoutMs} maxAgeMs=${threadBindingMaxAgeMs}`,
    );

    registerMatrixMonitorEvents({
      cfg,
      client,
      auth,
      allowFrom,
      dmEnabled,
      dmPolicy,
      readStoreAllowFrom: async () =>
        await core.channel.pairing
          .readAllowFromStore({
            channel: "matrix",
            env: process.env,
            accountId: account.accountId,
          })
          .catch(() => []),
      directTracker,
      logVerboseMessage,
      warnedEncryptedRooms,
      warnedCryptoMissingRooms,
      logger,
      formatNativeDependencyHint: core.system.formatNativeDependencyHint,
      onRoomMessage: trackRoomMessage,
    });

    // Register Matrix thread bindings before the client starts syncing so threaded
    // commands during startup never observe Matrix as "unavailable".
    logVerboseMessage("matrix: starting client");
    await resolveSharedMatrixClient({
      cfg,
      auth: authWithLimit,
      accountId: auth.accountId,
    });
    logVerboseMessage("matrix: client started");

    // Shared client is already started via resolveSharedMatrixClient.
    logger.info(`matrix: logged in as ${auth.userId}`);

    await runMatrixStartupMaintenance({
      client,
      auth,
      accountId: account.accountId,
      effectiveAccountId,
      accountConfig,
      logger,
      logVerboseMessage,
      loadConfig: () => core.config.loadConfig() as CoreConfig,
      writeConfigFile: async (nextCfg) => await core.config.writeConfigFile(nextCfg),
      loadWebMedia: async (url, maxBytes) => await core.media.loadWebMedia(url, maxBytes),
      env: process.env,
    });

    await new Promise<void>((resolve) => {
      const stopAndResolve = async () => {
        try {
          logVerboseMessage("matrix: stopping client");
          await cleanup();
        } catch (err) {
          logger.warn("matrix: failed during monitor shutdown cleanup", {
            error: String(err),
          });
        } finally {
          resolve();
        }
      };
      if (opts.abortSignal?.aborted) {
        void stopAndResolve();
        return;
      }
      opts.abortSignal?.addEventListener(
        "abort",
        () => {
          void stopAndResolve();
        },
        { once: true },
      );
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
}
