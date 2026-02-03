import { format } from "node:util";
import { mergeAllowlist, summarizeMapping, type RuntimeEnv } from "openclaw/plugin-sdk";
import type { CoreConfig, ReplyToMode } from "../../types.js";
import { resolveMatrixTargets } from "../../resolve-targets.js";
import { getMatrixRuntime } from "../../runtime.js";
import { setActiveMatrixClient } from "../active-client.js";
import {
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
  stopSharedClient,
} from "../client.js";
import { normalizeMatrixUserId } from "./allowlist.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createDirectRoomTracker } from "./direct.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";

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
  if (cfg.channels?.matrix?.enabled === false) {
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
    logger.debug(message);
  };

  const normalizeUserEntry = (raw: string) =>
    raw
      .replace(/^matrix:/i, "")
      .replace(/^user:/i, "")
      .trim();
  const normalizeRoomEntry = (raw: string) =>
    raw
      .replace(/^matrix:/i, "")
      .replace(/^(room|channel):/i, "")
      .trim();
  const isMatrixUserId = (value: string) => value.startsWith("@") && value.includes(":");
  const resolveUserAllowlist = async (
    label: string,
    list?: Array<string | number>,
  ): Promise<string[]> => {
    let allowList = list ?? [];
    if (allowList.length === 0) {
      return allowList;
    }
    const entries = allowList
      .map((entry) => normalizeUserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    if (entries.length === 0) {
      return allowList;
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
        cfg,
        inputs: pending,
        kind: "user",
        runtime,
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
    summarizeMapping(label, mapping, unresolved, runtime);
    if (unresolved.length > 0) {
      runtime.log?.(
        `${label} entries must be full Matrix IDs (example: @user:server). Unresolved entries are ignored.`,
      );
    }
    return allowList;
  };

  const allowlistOnly = cfg.channels?.matrix?.allowlistOnly === true;
  let allowFrom = cfg.channels?.matrix?.dm?.allowFrom ?? [];
  let groupAllowFrom = cfg.channels?.matrix?.groupAllowFrom ?? [];
  let roomsConfig = cfg.channels?.matrix?.groups ?? cfg.channels?.matrix?.rooms;

  allowFrom = await resolveUserAllowlist("matrix dm allowlist", allowFrom);
  groupAllowFrom = await resolveUserAllowlist("matrix group allowlist", groupAllowFrom);

  if (roomsConfig && Object.keys(roomsConfig).length > 0) {
    const mapping: string[] = [];
    const unresolved: string[] = [];
    const nextRooms: Record<string, (typeof roomsConfig)[string]> = {};
    if (roomsConfig["*"]) {
      nextRooms["*"] = roomsConfig["*"];
    }
    const pending: Array<{ input: string; query: string; config: (typeof roomsConfig)[string] }> =
      [];
    for (const [entry, roomConfig] of Object.entries(roomsConfig)) {
      if (entry === "*") {
        continue;
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }
      const cleaned = normalizeRoomEntry(trimmed);
      if ((cleaned.startsWith("!") || cleaned.startsWith("#")) && cleaned.includes(":")) {
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
        cfg,
        inputs: pending.map((entry) => entry.query),
        kind: "group",
        runtime,
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
    summarizeMapping("matrix rooms", mapping, unresolved, runtime);
    if (unresolved.length > 0) {
      runtime.log?.(
        "matrix rooms must be room IDs or aliases (example: !room:server or #alias:server). Unresolved entries are ignored.",
      );
    }
  }
  if (roomsConfig && Object.keys(roomsConfig).length > 0) {
    const nextRooms = { ...roomsConfig };
    for (const [roomKey, roomConfig] of Object.entries(roomsConfig)) {
      const users = roomConfig?.users ?? [];
      if (users.length === 0) {
        continue;
      }
      const resolvedUsers = await resolveUserAllowlist(`matrix room users (${roomKey})`, users);
      if (resolvedUsers !== users) {
        nextRooms[roomKey] = { ...roomConfig, users: resolvedUsers };
      }
    }
    roomsConfig = nextRooms;
  }

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
        ...(groupAllowFrom.length > 0 ? { groupAllowFrom } : {}),
        ...(roomsConfig ? { groups: roomsConfig } : {}),
      },
    },
  };

  const auth = await resolveMatrixAuth({ cfg });
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
  setActiveMatrixClient(client);

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicyRaw = cfg.channels?.matrix?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? cfg.channels?.matrix?.replyToMode ?? "off";
  const threadReplies = cfg.channels?.matrix?.threadReplies ?? "inbound";
  const dmConfig = cfg.channels?.matrix?.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "matrix");
  const mediaMaxMb = opts.mediaMaxMb ?? cfg.channels?.matrix?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const startupMs = Date.now();
  const startupGraceMs = 0;
  const directTracker = createDirectRoomTracker(client, { log: logVerboseMessage });
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
  });

  registerMatrixMonitorEvents({
    client,
    auth,
    logVerboseMessage,
    warnedEncryptedRooms,
    warnedCryptoMissingRooms,
    logger,
    formatNativeDependencyHint: core.system.formatNativeDependencyHint,
    onRoomMessage: handleRoomMessage,
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
      const verificationRequest = await client.crypto.requestOwnUserVerification();
      if (verificationRequest) {
        logger.info("matrix: device verification requested - please verify in another client");
      }
    } catch (err) {
      logger.debug(
        { error: String(err) },
        "Device verification request failed (may already be verified)",
      );
    }
  }

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      try {
        logVerboseMessage("matrix: stopping client");
        stopSharedClient();
      } finally {
        setActiveMatrixClient(null);
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
