import {
  GROUP_POLICY_BLOCKED_LABEL,
  mergeAllowlist,
  resolveRuntimeEnv,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  summarizeMapping,
  warnMissingProviderGroupPolicyFallbackOnce,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/matrix";
import { resolveMatrixTargets } from "../../resolve-targets.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig, MatrixConfig, MatrixRoomConfig, ReplyToMode } from "../../types.js";
import { resolveMatrixAccount } from "../accounts.js";
import { setActiveMatrixClient } from "../active-client.js";
import {
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
  stopSharedClientForAccount,
} from "../client.js";
import { normalizeMatrixUserId } from "./allowlist.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createDirectRoomTracker } from "./direct.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType } from "./types.js";

export type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
  accountId?: string | null;
};

const DEFAULT_MEDIA_MAX_MB = 20;
export const DEFAULT_STARTUP_GRACE_MS = 5000;

export function isConfiguredMatrixRoomEntry(entry: string): boolean {
  return entry.startsWith("!") || (entry.startsWith("#") && entry.includes(":"));
}

function normalizeMatrixUserEntry(raw: string): string {
  return raw
    .replace(/^matrix:/i, "")
    .replace(/^user:/i, "")
    .trim();
}

function normalizeMatrixRoomEntry(raw: string): string {
  return raw
    .replace(/^matrix:/i, "")
    .replace(/^(room|channel):/i, "")
    .trim();
}

function isMatrixUserId(value: string): boolean {
  return value.startsWith("@") && value.includes(":");
}

async function resolveMatrixUserAllowlist(params: {
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  label: string;
  list?: Array<string | number>;
}): Promise<string[]> {
  let allowList = params.list ?? [];
  if (allowList.length === 0) {
    return allowList.map(String);
  }
  const entries = allowList
    .map((entry) => normalizeMatrixUserEntry(String(entry)))
    .filter((entry) => entry && entry !== "*");
  if (entries.length === 0) {
    return allowList.map(String);
  }
  const mapping: string[] = [];
  const unresolved: string[] = [];
  const additions: string[] = [];
  const pending: string[] = [];
  for (const entry of entries) {
    if (isMatrixUserId(entry)) {
      additions.push(normalizeMatrixUserId(entry));
      continue;
    }
    pending.push(entry);
  }
  if (pending.length > 0) {
    const resolved = await resolveMatrixTargets({
      cfg: params.cfg,
      inputs: pending,
      kind: "user",
      runtime: params.runtime,
    });
    for (const entry of resolved) {
      if (entry.resolved && entry.id) {
        const normalizedId = normalizeMatrixUserId(entry.id);
        additions.push(normalizedId);
        mapping.push(`${entry.input}→${normalizedId}`);
      } else {
        unresolved.push(entry.input);
      }
    }
  }
  allowList = mergeAllowlist({ existing: allowList, additions });
  summarizeMapping(params.label, mapping, unresolved, params.runtime);
  if (unresolved.length > 0) {
    params.runtime.log?.(
      `${params.label} entries must be full Matrix IDs (example: @user:server). Unresolved entries are ignored.`,
    );
  }
  return allowList.map(String);
}

async function resolveMatrixRoomsConfig(params: {
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  roomsConfig?: Record<string, MatrixRoomConfig>;
}): Promise<Record<string, MatrixRoomConfig> | undefined> {
  let roomsConfig = params.roomsConfig;
  if (!roomsConfig || Object.keys(roomsConfig).length === 0) {
    return roomsConfig;
  }
  const mapping: string[] = [];
  const unresolved: string[] = [];
  const nextRooms: Record<string, MatrixRoomConfig> = {};
  if (roomsConfig["*"]) {
    nextRooms["*"] = roomsConfig["*"];
  }
  const pending: Array<{ input: string; query: string; config: MatrixRoomConfig }> = [];
  for (const [entry, roomConfig] of Object.entries(roomsConfig)) {
    if (entry === "*") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const cleaned = normalizeMatrixRoomEntry(trimmed);
    if (isConfiguredMatrixRoomEntry(cleaned)) {
      if (!nextRooms[cleaned]) {
        nextRooms[cleaned] = roomConfig;
      }
      if (cleaned !== entry) {
        mapping.push(`${entry}→${cleaned}`);
      }
      continue;
    }
    pending.push({ input: entry, query: trimmed, config: roomConfig });
  }
  if (pending.length > 0) {
    const resolved = await resolveMatrixTargets({
      cfg: params.cfg,
      inputs: pending.map((entry) => entry.query),
      kind: "group",
      runtime: params.runtime,
    });
    resolved.forEach((entry, index) => {
      const source = pending[index];
      if (!source) {
        return;
      }
      if (entry.resolved && entry.id) {
        if (!nextRooms[entry.id]) {
          nextRooms[entry.id] = source.config;
        }
        mapping.push(`${source.input}→${entry.id}`);
      } else {
        unresolved.push(source.input);
      }
    });
  }
  roomsConfig = nextRooms;
  summarizeMapping("matrix rooms", mapping, unresolved, params.runtime);
  if (unresolved.length > 0) {
    params.runtime.log?.(
      "matrix rooms must be room IDs or aliases (example: !room:server or #alias:server). Unresolved entries are ignored.",
    );
  }
  if (Object.keys(roomsConfig).length === 0) {
    return roomsConfig;
  }
  const nextRoomsWithUsers = { ...roomsConfig };
  for (const [roomKey, roomConfig] of Object.entries(roomsConfig)) {
    const users = roomConfig?.users ?? [];
    if (users.length === 0) {
      continue;
    }
    const resolvedUsers = await resolveMatrixUserAllowlist({
      cfg: params.cfg,
      runtime: params.runtime,
      label: `matrix room users (${roomKey})`,
      list: users,
    });
    if (resolvedUsers !== users) {
      nextRoomsWithUsers[roomKey] = { ...roomConfig, users: resolvedUsers };
    }
  }
  return nextRoomsWithUsers;
}

async function resolveMatrixMonitorConfig(params: {
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  accountConfig: MatrixConfig;
}): Promise<{
  allowFrom: string[];
  groupAllowFrom: string[];
  roomsConfig?: Record<string, MatrixRoomConfig>;
}> {
  const allowFrom = await resolveMatrixUserAllowlist({
    cfg: params.cfg,
    runtime: params.runtime,
    label: "matrix dm allowlist",
    list: params.accountConfig.dm?.allowFrom ?? [],
  });
  const groupAllowFrom = await resolveMatrixUserAllowlist({
    cfg: params.cfg,
    runtime: params.runtime,
    label: "matrix group allowlist",
    list: params.accountConfig.groupAllowFrom ?? [],
  });
  const roomsConfig = await resolveMatrixRoomsConfig({
    cfg: params.cfg,
    runtime: params.runtime,
    roomsConfig: params.accountConfig.groups ?? params.accountConfig.rooms,
  });
  return { allowFrom, groupAllowFrom, roomsConfig };
}

export async function monitorMatrixProvider(opts: MonitorMatrixOpts = {}): Promise<void> {
  if (isBunRuntime()) {
    throw new Error("Matrix provider requires Node (bun runtime not supported)");
  }
  const core = getMatrixRuntime();
  let cfg = core.config.loadConfig() as CoreConfig;
  if (cfg.channels?.matrix?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "matrix-auto-reply" });
  const runtime: RuntimeEnv = resolveRuntimeEnv({
    runtime: opts.runtime,
    logger,
  });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };

  // Resolve account-specific config for multi-account support
  const account = resolveMatrixAccount({ cfg, accountId: opts.accountId });
  const accountConfig = account.config;
  const allowlistOnly = accountConfig.allowlistOnly === true;
  const { allowFrom, groupAllowFrom, roomsConfig } = await resolveMatrixMonitorConfig({
    cfg,
    runtime,
    accountConfig,
  });

  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.matrix,
        dm: {
          ...cfg.channels?.matrix?.dm,
          allowFrom,
        },
        groupAllowFrom,
        ...(roomsConfig ? { groups: roomsConfig } : {}),
      },
    },
  };

  const auth = await resolveMatrixAuth({ cfg, accountId: opts.accountId });
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
    accountId: opts.accountId,
  });
  setActiveMatrixClient(client, opts.accountId);

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy: groupPolicyRaw, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.matrix !== undefined,
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
  const dmConfig = accountConfig.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "matrix");
  const mediaMaxMb = opts.mediaMaxMb ?? accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const startupMs = Date.now();
  const startupGraceMs = DEFAULT_STARTUP_GRACE_MS;
  const directTracker = createDirectRoomTracker(client, {
    log: logVerboseMessage,
    includeMemberCountInLogs: core.logging.shouldLogVerbose(),
  });
  registerMatrixAutoJoin({ client, cfg, runtime });
  const warnedEncryptedRooms = new Set<string>();
  const warnedCryptoMissingRooms = new Set<string>();

  const { getRoomInfo, getMemberDisplayName } = createMatrixRoomInfoResolver(client);
  const handleRoomMessage = createMatrixRoomMessageHandler({
    client,
    core,
    cfg,
    runtime,
    logger,
    logVerboseMessage,
    allowFrom,
    roomsConfig,
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
    directTracker,
    getRoomInfo,
    getMemberDisplayName,
    accountId: opts.accountId,
  });

  // Set up inbound message debouncing to batch rapid messages from the same sender
  const debounceMs = core.channel.debounce.resolveInboundDebounceMs({ cfg, channel: "matrix" });

  type MatrixDebounceEntry = {
    roomId: string;
    event: MatrixRawEvent;
    debounceKey: string | null;
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<MatrixDebounceEntry>({
    debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      const event = entry.event;
      // Don't debounce non-message events
      if (event.type !== EventType.RoomMessage) {
        return false;
      }
      // Don't debounce if no text content (media-only)
      const content = event.content as RoomMessageEventContent | undefined;
      const text = typeof content?.body === "string" ? content.body.trim() : "";
      if (!text) {
        return false;
      }
      // Don't debounce control commands - process immediately
      if (core.channel.text.hasControlCommand(text, cfg)) {
        return false;
      }
      return true;
    },
    onFlush: async (entries) => {
      if (entries.length === 0) {
        return;
      }

      // Single message - process directly
      if (entries.length === 1) {
        const entry = entries[0];
        if (entry) {
          await handleRoomMessage(entry.roomId, entry.event);
        }
        return;
      }

      // Multiple messages - combine text and process as one
      const first = entries[0];
      const last = entries.at(-1);
      if (!first || !last) {
        return;
      }

      // Combine body text from all events
      const combinedText = entries
        .map((entry) => {
          const content = entry.event.content as RoomMessageEventContent | undefined;
          return typeof content?.body === "string" ? content.body : "";
        })
        .filter(Boolean)
        .join("\n");

      if (!combinedText.trim()) {
        // No text to combine, just process the first event
        await handleRoomMessage(first.roomId, first.event);
        return;
      }

      // Create synthetic event with combined text, using last event's ID for reply targeting
      const syntheticEvent: MatrixRawEvent = {
        ...first.event,
        event_id: last.event.event_id,
        origin_server_ts: last.event.origin_server_ts ?? first.event.origin_server_ts,
        content: {
          ...first.event.content,
          body: combinedText,
        },
      };

      logVerboseMessage(
        `matrix: debounced ${entries.length} messages from ${first.event.sender ?? "unknown"} in ${first.roomId}`,
      );

      await handleRoomMessage(first.roomId, syntheticEvent);
    },
    onError: (err) => {
      runtime.error?.(`matrix debounce flush failed: ${String(err)}`);
    },
  });

  // Wrapper that enqueues events to the debouncer
  const debouncedRoomMessageHandler = async (roomId: string, event: MatrixRawEvent) => {
    const senderId = event.sender;
    // Build debounce key: channel:accountId:room:sender
    const accountId = opts.accountId ?? "default";
    const debounceKey = senderId ? `matrix:${accountId}:${roomId}:${senderId}` : null;

    await inboundDebouncer.enqueue({
      roomId,
      event,
      debounceKey,
    });
  };

  registerMatrixMonitorEvents({
    client,
    auth,
    logVerboseMessage,
    warnedEncryptedRooms,
    warnedCryptoMissingRooms,
    logger,
    formatNativeDependencyHint: core.system.formatNativeDependencyHint,
    onRoomMessage: debouncedRoomMessageHandler,
  });

  logVerboseMessage("matrix: starting client");
  await resolveSharedMatrixClient({
    cfg,
    auth: authWithLimit,
    accountId: opts.accountId,
  });
  logVerboseMessage("matrix: client started");

  // @vector-im/matrix-bot-sdk client is already started via resolveSharedMatrixClient
  logger.info(`matrix: logged in as ${auth.userId}`);

  // If E2EE is enabled, trigger device verification
  if (auth.encryption && client.crypto) {
    try {
      // Request verification from other sessions
      const verificationRequest = await (
        client.crypto as { requestOwnUserVerification?: () => Promise<unknown> }
      ).requestOwnUserVerification?.();
      if (verificationRequest) {
        logger.info("matrix: device verification requested - please verify in another client");
      }
    } catch (err) {
      logger.debug?.("Device verification request failed (may already be verified)", {
        error: String(err),
      });
    }
  }

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      try {
        logVerboseMessage("matrix: stopping client");
        stopSharedClientForAccount(auth, opts.accountId);
      } finally {
        setActiveMatrixClient(null, opts.accountId);
        resolve();
      }
    };
    if (opts.abortSignal?.aborted) {
      onAbort();
      return;
    }
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
