import type {
  LocationMessageEventContent,
  MatrixClient,
  MessageEventContent,
} from "matrix-bot-sdk";
import { format } from "node:util";

import {
  formatAllowlistMatchMeta,
  formatLocationText,
  mergeAllowlist,
  summarizeMapping,
  toLocationContext,
  type NormalizedLocation,
  type ReplyPayload,
  type RuntimeEnv,
} from "clawdbot/plugin-sdk";
import type { CoreConfig, ReplyToMode } from "../../types.js";
import { setActiveMatrixClient } from "../active-client.js";
import {
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
  stopSharedClient,
} from "../client.js";
import {
  formatPollAsText,
  isPollStartType,
  type PollStartContent,
  parsePollStartContent,
} from "../poll-types.js";
import {
  reactMatrixMessage,
  sendMessageMatrix,
  sendReadReceiptMatrix,
  sendTypingMatrix,
} from "../send.js";
import {
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches,
  normalizeAllowListLower,
} from "./allowlist.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createDirectRoomTracker } from "./direct.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions } from "./mentions.js";
import { deliverMatrixReplies } from "./replies.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadTarget } from "./threads.js";
import { resolveMatrixTargets } from "../../resolve-targets.js";
import { getMatrixRuntime } from "../../runtime.js";

// Constants that were previously from matrix-js-sdk
const EventType = {
  RoomMessage: "m.room.message",
  RoomMessageEncrypted: "m.room.encrypted",
  RoomMember: "m.room.member",
  Location: "m.location",
} as const;

const RelationType = {
  Replace: "m.replace",
} as const;

// Type for raw Matrix events from matrix-bot-sdk
type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
};

type RoomMessageEventContent = MessageEventContent & {
  url?: string;
  info?: {
    mimetype?: string;
  };
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};

type MatrixLocationPayload = {
  text: string;
  context: ReturnType<typeof toLocationContext>;
};

type GeoUriParams = {
  latitude: number;
  longitude: number;
  accuracy?: number;
};

function parseGeoUri(value: string): GeoUriParams | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.toLowerCase().startsWith("geo:")) return null;
  const payload = trimmed.slice(4);
  const [coordsPart, ...paramParts] = payload.split(";");
  const coords = coordsPart.split(",");
  if (coords.length < 2) return null;
  const latitude = Number.parseFloat(coords[0] ?? "");
  const longitude = Number.parseFloat(coords[1] ?? "");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const params = new Map<string, string>();
  for (const part of paramParts) {
    const segment = part.trim();
    if (!segment) continue;
    const eqIndex = segment.indexOf("=");
    const rawKey = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : segment.slice(eqIndex + 1);
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const valuePart = rawValue.trim();
    params.set(key, valuePart ? decodeURIComponent(valuePart) : "");
  }

  const accuracyRaw = params.get("u");
  const accuracy = accuracyRaw ? Number.parseFloat(accuracyRaw) : undefined;

  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
  };
}

function resolveMatrixLocation(params: {
  eventType: string;
  content: LocationMessageEventContent;
}): MatrixLocationPayload | null {
  const { eventType, content } = params;
  const isLocation =
    eventType === EventType.Location ||
    (eventType === EventType.RoomMessage && content.msgtype === EventType.Location);
  if (!isLocation) return null;
  const geoUri = typeof content.geo_uri === "string" ? content.geo_uri.trim() : "";
  if (!geoUri) return null;
  const parsed = parseGeoUri(geoUri);
  if (!parsed) return null;
  const caption = typeof content.body === "string" ? content.body.trim() : "";
  const location: NormalizedLocation = {
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    accuracy: parsed.accuracy,
    caption: caption || undefined,
    source: "pin",
    isLive: false,
  };

  return {
    text: formatLocationText(location),
    context: toLocationContext(location),
  };
}

export type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
};

const DEFAULT_MEDIA_MAX_MB = 20;

export async function monitorMatrixProvider(opts: MonitorMatrixOpts = {}): Promise<void> {
  if (isBunRuntime()) {
    throw new Error("Matrix provider requires Node (bun runtime not supported)");
  }
  const core = getMatrixRuntime();
  let cfg = core.config.loadConfig() as CoreConfig;
  if (cfg.channels?.matrix?.enabled === false) return;

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
    if (!core.logging.shouldLogVerbose()) return;
    logger.debug(message);
  };

  const normalizeUserEntry = (raw: string) =>
    raw.replace(/^matrix:/i, "").replace(/^user:/i, "").trim();
  const normalizeRoomEntry = (raw: string) =>
    raw.replace(/^matrix:/i, "").replace(/^(room|channel):/i, "").trim();
  const isMatrixUserId = (value: string) => value.startsWith("@") && value.includes(":");

  const allowlistOnly = cfg.channels?.matrix?.allowlistOnly === true;
  let allowFrom = cfg.channels?.matrix?.dm?.allowFrom ?? [];
  let roomsConfig = cfg.channels?.matrix?.groups ?? cfg.channels?.matrix?.rooms;

  if (allowFrom.length > 0) {
    const entries = allowFrom
      .map((entry) => normalizeUserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    if (entries.length > 0) {
      const mapping: string[] = [];
      const unresolved: string[] = [];
      const additions: string[] = [];
      const pending: string[] = [];
      for (const entry of entries) {
        if (isMatrixUserId(entry)) {
          additions.push(entry);
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
            additions.push(entry.id);
            mapping.push(`${entry.input}→${entry.id}`);
          } else {
            unresolved.push(entry.input);
          }
        }
      }
      allowFrom = mergeAllowlist({ existing: allowFrom, additions });
      summarizeMapping("matrix users", mapping, unresolved, runtime);
    }
  }

  if (roomsConfig && Object.keys(roomsConfig).length > 0) {
    const entries = Object.keys(roomsConfig).filter((key) => key !== "*");
    const mapping: string[] = [];
    const unresolved: string[] = [];
    const nextRooms = { ...roomsConfig };
    const pending: Array<{ input: string; query: string }> = [];
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const cleaned = normalizeRoomEntry(trimmed);
      if (cleaned.startsWith("!") && cleaned.includes(":")) {
        if (!nextRooms[cleaned]) {
          nextRooms[cleaned] = roomsConfig[entry];
        }
        mapping.push(`${entry}→${cleaned}`);
        continue;
      }
      pending.push({ input: entry, query: trimmed });
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
        if (!source) return;
        if (entry.resolved && entry.id) {
          if (!nextRooms[entry.id]) {
            nextRooms[entry.id] = roomsConfig[source.input];
          }
          mapping.push(`${source.input}→${entry.id}`);
        } else {
          unresolved.push(source.input);
        }
      });
    }
    roomsConfig = nextRooms;
    summarizeMapping("matrix rooms", mapping, unresolved, runtime);
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

  const roomInfoCache = new Map<
    string,
    { name?: string; canonicalAlias?: string; altAliases: string[] }
  >();

  // Helper to get room info
  const getRoomInfo = async (roomId: string) => {
    const cached = roomInfoCache.get(roomId);
    if (cached) return cached;
    let name: string | undefined;
    let canonicalAlias: string | undefined;
    let altAliases: string[] = [];
    try {
      const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "").catch(() => null);
      name = nameState?.name;
    } catch { /* ignore */ }
    try {
      const aliasState = await client.getRoomStateEvent(roomId, "m.room.canonical_alias", "").catch(() => null);
      canonicalAlias = aliasState?.alias;
      altAliases = aliasState?.alt_aliases ?? [];
    } catch { /* ignore */ }
    const info = { name, canonicalAlias, altAliases };
    roomInfoCache.set(roomId, info);
    return info;
  };

  // Helper to get member display name
  const getMemberDisplayName = async (roomId: string, userId: string): Promise<string> => {
    try {
      const memberState = await client.getRoomStateEvent(roomId, "m.room.member", userId).catch(() => null);
      return memberState?.displayname ?? userId;
    } catch {
      return userId;
    }
  };

  const handleRoomMessage = async (
    roomId: string,
    event: MatrixRawEvent,
  ) => {
    try {
      const eventType = event.type;
      if (eventType === EventType.RoomMessageEncrypted) {
        // Encrypted messages are decrypted automatically by matrix-bot-sdk with crypto enabled
        return;
      }

      const isPollEvent = isPollStartType(eventType);
      const locationContent = event.content as LocationMessageEventContent;
      const isLocationEvent =
        eventType === EventType.Location ||
        (eventType === EventType.RoomMessage &&
          locationContent.msgtype === EventType.Location);
      if (eventType !== EventType.RoomMessage && !isPollEvent && !isLocationEvent) return;
      logVerboseMessage(
        `matrix: room.message recv room=${roomId} type=${eventType} id=${event.event_id ?? "unknown"}`,
      );
      if (event.unsigned?.redacted_because) return;
      const senderId = event.sender;
      if (!senderId) return;
      const selfUserId = await client.getUserId();
      if (senderId === selfUserId) return;
      const eventTs = event.origin_server_ts;
      const eventAge = event.unsigned?.age;
      if (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) {
        return;
      }
      if (
        typeof eventTs !== "number" &&
        typeof eventAge === "number" &&
        eventAge > startupGraceMs
      ) {
        return;
      }

      const roomInfo = await getRoomInfo(roomId);
      const roomName = roomInfo.name;
      const roomAliases = [
        roomInfo.canonicalAlias ?? "",
        ...roomInfo.altAliases,
      ].filter(Boolean);

      let content = event.content as RoomMessageEventContent;
      if (isPollEvent) {
        const pollStartContent = event.content as PollStartContent;
        const pollSummary = parsePollStartContent(pollStartContent);
        if (pollSummary) {
          pollSummary.eventId = event.event_id ?? "";
          pollSummary.roomId = roomId;
          pollSummary.sender = senderId;
          const senderDisplayName = await getMemberDisplayName(roomId, senderId);
          pollSummary.senderName = senderDisplayName;
          const pollText = formatPollAsText(pollSummary);
          content = {
            msgtype: "m.text",
            body: pollText,
          } as unknown as RoomMessageEventContent;
        } else {
          return;
        }
      }

      const locationPayload = resolveMatrixLocation({
        eventType,
        content: content as LocationMessageEventContent,
      });

      const relates = content["m.relates_to"];
      if (relates && "rel_type" in relates) {
        if (relates.rel_type === RelationType.Replace) return;
      }

      const isDirectMessage = await directTracker.isDirectMessage({
        roomId,
        senderId,
        selfUserId,
      });
      const isRoom = !isDirectMessage;

      if (isRoom && groupPolicy === "disabled") return;

      const roomConfigInfo = isRoom
        ? resolveMatrixRoomConfig({
            rooms: roomsConfig,
            roomId,
            aliases: roomAliases,
            name: roomName,
          })
        : undefined;
      const roomConfig = roomConfigInfo?.config;
      const roomMatchMeta = roomConfigInfo
        ? `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${
            roomConfigInfo.matchSource ?? "none"
          }`
        : "matchKey=none matchSource=none";

      if (isRoom && roomConfig && !roomConfigInfo?.allowed) {
        logVerboseMessage(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);
        return;
      }
      if (isRoom && groupPolicy === "allowlist") {
        if (!roomConfigInfo?.allowlistConfigured) {
          logVerboseMessage(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);
          return;
        }
        if (!roomConfig) {
          logVerboseMessage(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);
          return;
        }
      }

      const senderName = await getMemberDisplayName(roomId, senderId);
      const storeAllowFrom = await core.channel.pairing.readAllowFromStore("matrix").catch(() => []);
      const effectiveAllowFrom = normalizeAllowListLower([...allowFrom, ...storeAllowFrom]);
      const groupAllowFrom = cfg.channels?.matrix?.groupAllowFrom ?? [];
      const effectiveGroupAllowFrom = normalizeAllowListLower([
        ...groupAllowFrom,
        ...storeAllowFrom,
      ]);
      const groupAllowConfigured = effectiveGroupAllowFrom.length > 0;

      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") return;
        if (dmPolicy !== "open") {
          const allowMatch = resolveMatrixAllowListMatch({
            allowList: effectiveAllowFrom,
            userId: senderId,
            userName: senderName,
          });
          const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
          if (!allowMatch.allowed) {
            if (dmPolicy === "pairing") {
              const { code, created } = await core.channel.pairing.upsertPairingRequest({
                channel: "matrix",
                id: senderId,
                meta: { name: senderName },
              });
              if (created) {
                logVerboseMessage(
                  `matrix pairing request sender=${senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`,
                );
                try {
                  await sendMessageMatrix(
                    `room:${roomId}`,
                    [
                      "Clawdbot: access not configured.",
                      "",
                      `Pairing code: ${code}`,
                      "",
                      "Ask the bot owner to approve with:",
                      "clawdbot pairing approve matrix <code>",
                    ].join("\n"),
                    { client },
                  );
                } catch (err) {
                  logVerboseMessage(`matrix pairing reply failed for ${senderId}: ${String(err)}`);
                }
              }
            }
            if (dmPolicy !== "pairing") {
              logVerboseMessage(
                `matrix: blocked dm sender ${senderId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
              );
            }
            return;
          }
        }
      }

      const roomUsers = roomConfig?.users ?? [];
      if (isRoom && roomUsers.length > 0) {
        const userMatch = resolveMatrixAllowListMatch({
          allowList: normalizeAllowListLower(roomUsers),
          userId: senderId,
          userName: senderName,
        });
        if (!userMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (room users allowlist, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              userMatch,
            )})`,
          );
          return;
        }
      }
      if (isRoom && groupPolicy === "allowlist" && roomUsers.length === 0 && groupAllowConfigured) {
        const groupAllowMatch = resolveMatrixAllowListMatch({
          allowList: effectiveGroupAllowFrom,
          userId: senderId,
          userName: senderName,
        });
        if (!groupAllowMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (groupAllowFrom, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              groupAllowMatch,
            )})`,
          );
          return;
        }
      }
      if (isRoom) {
        logVerboseMessage(`matrix: allow room ${roomId} (${roomMatchMeta})`);
      }

      const rawBody = locationPayload?.text
        ?? (typeof content.body === "string" ? content.body.trim() : "");
      let media: {
        path: string;
        contentType?: string;
        placeholder: string;
      } | null = null;
      const contentUrl =
        "url" in content && typeof content.url === "string" ? content.url : undefined;
      if (!rawBody && !contentUrl) {
        return;
      }

      const contentType =
        "info" in content && content.info && "mimetype" in content.info
          ? (content.info as { mimetype?: string }).mimetype
          : undefined;
      if (contentUrl?.startsWith("mxc://")) {
        try {
          media = await downloadMatrixMedia({
            client,
            mxcUrl: contentUrl,
            contentType,
            maxBytes: mediaMaxBytes,
          });
        } catch (err) {
          logVerboseMessage(`matrix: media download failed: ${String(err)}`);
        }
      }

      const bodyText = rawBody || media?.placeholder || "";
      if (!bodyText) return;

      const { wasMentioned, hasExplicitMention } = resolveMentions({
        content,
        userId: selfUserId,
        text: bodyText,
        mentionRegexes,
      });
      const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
        cfg,
        surface: "matrix",
      });
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const senderAllowedForCommands = resolveMatrixAllowListMatches({
        allowList: effectiveAllowFrom,
        userId: senderId,
        userName: senderName,
      });
      const senderAllowedForGroup = groupAllowConfigured
        ? resolveMatrixAllowListMatches({
            allowList: effectiveGroupAllowFrom,
            userId: senderId,
            userName: senderName,
          })
        : false;
      const senderAllowedForRoomUsers =
        isRoom && roomUsers.length > 0
          ? resolveMatrixAllowListMatches({
              allowList: normalizeAllowListLower(roomUsers),
              userId: senderId,
              userName: senderName,
            })
          : false;
      const commandAuthorized = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
          { configured: roomUsers.length > 0, allowed: senderAllowedForRoomUsers },
          { configured: groupAllowConfigured, allowed: senderAllowedForGroup },
        ],
      });
      if (
        isRoom &&
        allowTextCommands &&
        core.channel.text.hasControlCommand(bodyText, cfg) &&
        !commandAuthorized
      ) {
        logVerboseMessage(`matrix: drop control command from unauthorized sender ${senderId}`);
        return;
      }
      const shouldRequireMention = isRoom
        ? roomConfig?.autoReply === true
          ? false
          : roomConfig?.autoReply === false
            ? true
            : typeof roomConfig?.requireMention === "boolean"
              ? roomConfig?.requireMention
              : true
        : false;
      const shouldBypassMention =
        allowTextCommands &&
        isRoom &&
        shouldRequireMention &&
        !wasMentioned &&
        !hasExplicitMention &&
        commandAuthorized &&
        core.channel.text.hasControlCommand(bodyText);
      if (isRoom && shouldRequireMention && !wasMentioned && !shouldBypassMention) {
        logger.info({ roomId, reason: "no-mention" }, "skipping room message");
        return;
      }

      const messageId = event.event_id ?? "";
      const replyToEventId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
      const threadRootId = resolveMatrixThreadRootId({ event, content });
	      const threadTarget = resolveMatrixThreadTarget({
	        threadReplies,
	        messageId,
	        threadRootId,
	        isThreadRoot: false, // matrix-bot-sdk doesn't have this info readily available
	      });

	      const route = core.channel.routing.resolveAgentRoute({
	        cfg,
	        channel: "matrix",
	        peer: {
	          kind: isDirectMessage ? "dm" : "channel",
	          id: isDirectMessage ? senderId : roomId,
	        },
	      });
	      const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
	      const textWithId = `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
	      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
	        agentId: route.agentId,
	      });
	      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
	      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
	        storePath,
	        sessionKey: route.sessionKey,
	      });
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "Matrix",
        from: envelopeFrom,
        timestamp: eventTs ?? undefined,
        previousTimestamp,
        envelope: envelopeOptions,
        body: textWithId,
      });

      const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || undefined;
      const ctxPayload = core.channel.reply.finalizeInboundContext({
	        Body: body,
	        RawBody: bodyText,
	        CommandBody: bodyText,
	        From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
	        To: `room:${roomId}`,
	        SessionKey: route.sessionKey,
	        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "channel",
        ConversationLabel: envelopeFrom,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderId.split(":")[0]?.replace(/^@/, ""),
        GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
        GroupChannel: isRoom ? (roomInfo.canonicalAlias ?? roomId) : undefined,
        GroupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
        Provider: "matrix" as const,
        Surface: "matrix" as const,
        WasMentioned: isRoom ? wasMentioned : undefined,
        MessageSid: messageId,
        ReplyToId: threadTarget ? undefined : (replyToEventId ?? undefined),
        MessageThreadId: threadTarget,
        Timestamp: eventTs ?? undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        ...(locationPayload?.context ?? {}),
	        CommandAuthorized: commandAuthorized,
	        CommandSource: "text" as const,
	        OriginatingChannel: "matrix" as const,
	        OriginatingTo: `room:${roomId}`,
	      });

	      void core.channel.session.recordSessionMetaFromInbound({
	        storePath,
	        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
	        ctx: ctxPayload,
      }).catch((err) => {
        logger.warn(
          { error: String(err), storePath, sessionKey: ctxPayload.SessionKey ?? route.sessionKey },
          "failed updating session meta",
        );
      });

      if (isDirectMessage) {
        await core.channel.session.updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          channel: "matrix",
          to: `room:${roomId}`,
          accountId: route.accountId,
          ctx: ctxPayload,
        });
      }

      const preview = bodyText.slice(0, 200).replace(/\n/g, "\\n");
      logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);

      const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
      const ackScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      const shouldAckReaction = () => {
        if (!ackReaction) return false;
        if (ackScope === "all") return true;
        if (ackScope === "direct") return isDirectMessage;
        if (ackScope === "group-all") return isRoom;
        if (ackScope === "group-mentions") {
          if (!isRoom) return false;
          if (!shouldRequireMention) return false;
          return wasMentioned || shouldBypassMention;
        }
        return false;
      };
      if (shouldAckReaction() && messageId) {
        reactMatrixMessage(roomId, messageId, ackReaction, client).catch((err) => {
          logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
        });
      }

      const replyTarget = ctxPayload.To;
      if (!replyTarget) {
        runtime.error?.("matrix: missing reply target");
        return;
      }

      if (messageId) {
        sendReadReceiptMatrix(roomId, messageId, client).catch((err) => {
          logVerboseMessage(
            `matrix: read receipt failed room=${roomId} id=${messageId}: ${String(err)}`,
          );
        });
      }

      let didSendReply = false;
      const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
        responsePrefix: core.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload) => {
          await deliverMatrixReplies({
            replies: [payload],
            roomId,
            client,
            runtime,
            textLimit,
            replyToMode,
            threadId: threadTarget,
          });
          didSendReply = true;
        },
        onError: (err, info) => {
          runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: () => sendTypingMatrix(roomId, true, undefined, client).catch(() => {}),
        onIdle: () => sendTypingMatrix(roomId, false, undefined, client).catch(() => {}),
      });

      const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          skillFilter: roomConfig?.skills,
        },
      });
      markDispatchIdle();
      if (!queuedFinal) return;
      didSendReply = true;
      const finalCount = counts.final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
      if (didSendReply) {
        const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
        core.system.enqueueSystemEvent(`Matrix message from ${senderName}: ${preview}`, {
          sessionKey: route.sessionKey,
          contextKey: `matrix:message:${roomId}:${messageId || "unknown"}`,
        });
      }
    } catch (err) {
      runtime.error?.(`matrix handler failed: ${String(err)}`);
    }
  };

  // matrix-bot-sdk uses on("room.message", handler)
  client.on("room.message", handleRoomMessage);

  client.on("room.encrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: encrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  client.on("room.decrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: decrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  // Handle failed E2EE decryption
  client.on("room.failed_decryption", async (roomId: string, event: MatrixRawEvent, error: Error) => {
    logger.warn({ roomId, eventId: event.event_id, error: error.message }, "Failed to decrypt message");
    logVerboseMessage(
      `matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} error=${error.message}`,
    );
  });

  client.on("room.invite", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const sender = event?.sender ?? "unknown";
    const isDirect = (event?.content as { is_direct?: boolean } | undefined)?.is_direct === true;
    logVerboseMessage(
      `matrix: invite room=${roomId} sender=${sender} direct=${String(isDirect)} id=${eventId}`,
    );
  });

  client.on("room.join", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    logVerboseMessage(`matrix: join room=${roomId} id=${eventId}`);
  });

  client.on("room.event", (roomId: string, event: MatrixRawEvent) => {
    const eventType = event?.type ?? "unknown";
    if (eventType === EventType.RoomMessageEncrypted) {
      logVerboseMessage(
        `matrix: encrypted raw event room=${roomId} id=${event?.event_id ?? "unknown"}`,
      );
      if (auth.encryption !== true && !warnedEncryptedRooms.has(roomId)) {
        warnedEncryptedRooms.add(roomId);
        const warning =
          "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt";
        logger.warn({ roomId }, warning);
      }
      if (auth.encryption === true && !client.crypto && !warnedCryptoMissingRooms.has(roomId)) {
        warnedCryptoMissingRooms.add(roomId);
        const warning =
          "matrix: encryption enabled but crypto is unavailable; install @matrix-org/matrix-sdk-crypto-nodejs and restart";
        logger.warn({ roomId }, warning);
      }
      return;
    }
    if (eventType === EventType.RoomMember) {
      const membership = (event?.content as { membership?: string } | undefined)?.membership;
      const stateKey = (event as { state_key?: string }).state_key ?? "";
      logVerboseMessage(
        `matrix: member event room=${roomId} stateKey=${stateKey} membership=${membership ?? "unknown"}`,
      );
    }
  });

  logVerboseMessage("matrix: starting client");
  await resolveSharedMatrixClient({
    cfg,
    auth: authWithLimit,
  });
  logVerboseMessage("matrix: client started");

  // matrix-bot-sdk client is already started via resolveSharedMatrixClient
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
      logger.debug({ error: String(err) }, "Device verification request failed (may already be verified)");
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
