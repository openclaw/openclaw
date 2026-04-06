import { format } from "node:util";
import { MatrixExecApprovalHandler } from "../../exec-approvals-handler.js";
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
import { resolveMatrixAccountConfig } from "../account-config.js";
import { resolveConfiguredMatrixBotUserIds } from "../accounts.js";
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
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";
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
  // Fast-cancel callers should not pay the full Matrix startup/import cost.
  if (opts.abortSignal?.aborted) {
    return;
  }
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
  const accountConfig = resolveMatrixAccountConfig({
    cfg,
    accountId: effectiveAccountId,
  });

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
  let execApprovalsHandler: MatrixExecApprovalHandler | null = null;
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
      await execApprovalsHandler?.stop();
      threadBindingManager?.stop();
      await inboundDeduper.stop();
      await releaseSharedClientInstance(client, "persist");
    } finally {
      setActiveMatrixClient(null, auth.accountId);
    }
  };

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
    accountId: effectiveAccountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => logVerboseMessage(message),
  });
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? accountConfig.replyToMode ?? "off";
  const threadReplies = accountConfig.threadReplies ?? "inbound";
  const dmThreadReplies = accountConfig.dm?.threadReplies;
  const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg,
    channel: "matrix",
    accountId: effectiveAccountId,
  });
  const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg,
    channel: "matrix",
    accountId: effectiveAccountId,
  });
  const dmConfig = accountConfig.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const dmSessionScope = dmConfig?.sessionScope ?? "per-user";
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "matrix", effectiveAccountId);
  const globalGroupChatHistoryLimit = (
    cfg.messages as { groupChat?: { historyLimit?: number } } | undefined
  )?.groupChat?.historyLimit;
  const historyLimit = Math.max(0, accountConfig.historyLimit ?? globalGroupChatHistoryLimit ?? 0);
  const mediaMaxMb = opts.mediaMaxMb ?? accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const streaming: "partial" | "quiet" | "off" =
    accountConfig.streaming === true || accountConfig.streaming === "partial"
      ? "partial"
      : accountConfig.streaming === "quiet"
        ? "quiet"
        : "off";
  const blockStreamingEnabled = accountConfig.blockStreaming === true;
  const startupMs = Date.now();
  const startupGraceMs = 0;
  // Cold starts should ignore old room history, but once we have a persisted
  // /sync cursor we want restart backlogs to replay just like other channels.
  const dropPreStartupMessages = !client.hasPersistedSyncState();
  const { getRoomInfo, getMemberDisplayName } = createMatrixRoomInfoResolver(client);
  const directTracker = createDirectRoomTracker(client, {
    log: logVerboseMessage,
    canPromoteRecentInvite: async (roomId) =>
      shouldPromoteRecentInviteRoom({
        roomId,
        roomInfo: await getRoomInfo(roomId, { includeAliases: true }),
        rooms: roomsConfig,
      }),
    shouldKeepLocallyPromotedDirectRoom: async (roomId) => {
      try {
        const roomInfo = await getRoomInfo(roomId, { includeAliases: true });
        if (!roomInfo.nameResolved || !roomInfo.aliasesResolved) {
          return undefined;
        }
        return shouldPromoteRecentInviteRoom({
          roomId,
          roomInfo,
          rooms: roomsConfig,
        });
      } catch (err) {
        logVerboseMessage(
          `matrix: local promotion revalidation failed room=${roomId} (${String(err)})`,
        );
        return undefined;
      }
    },
  });
  registerMatrixAutoJoin({ client, accountConfig, runtime });
  const warnedEncryptedRooms = new Set<string>();
  const warnedCryptoMissingRooms = new Set<string>();

  const handleRoomMessage = createMatrixRoomMessageHandler({
    client,
    core,
    cfg,
    accountId: effectiveAccountId,
    runtime,
    logger,
    logVerboseMessage,
    allowFrom,
    groupAllowFrom,
    roomsConfig,
    accountAllowBots,
    configuredBotUserIds,
    groupPolicy,
    replyToMode,
    threadReplies,
    dmThreadReplies,
    dmSessionScope,
    streaming,
    blockStreamingEnabled,
    dmEnabled,
    dmPolicy,
    textLimit,
    mediaMaxBytes,
    historyLimit,
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
      accountId: effectiveAccountId,
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
            accountId: effectiveAccountId,
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

    execApprovalsHandler = new MatrixExecApprovalHandler({
      client,
      accountId: effectiveAccountId,
      cfg,
    });
    await execApprovalsHandler.start();

    await runMatrixStartupMaintenance({
      client,
      auth,
      accountId: effectiveAccountId,
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
