import type { ChannelAccountSnapshot, GroupPolicy, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  createScopedPairingAccess,
  formatTextWithAttachmentLinks,
  issuePairingChallenge,
  readStoreAllowFromForDmPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  resolveOutboundMediaUrls,
} from "openclaw/plugin-sdk";
import { getNapCatRuntime } from "./runtime.js";
import { sendNapCatMedia, sendNapCatText } from "./send.js";
import { isNapCatSenderAllowed, normalizeNapCatAllowEntry } from "./targets.js";
import type {
  NapCatGroupConfig,
  NapCatInboundMessage,
  OneBotMessageEvent,
  OneBotSegment,
  ResolvedNapCatAccount,
} from "./types.js";

const CHANNEL_ID = "napcat" as const;
const DEDUP_WINDOW_MS = 120_000;

const inboundDedup = new Map<string, number>();

function cleanupDedup(nowMs: number) {
  for (const [key, timestamp] of inboundDedup) {
    if (nowMs - timestamp > DEDUP_WINDOW_MS) {
      inboundDedup.delete(key);
    }
  }
}

function dedupKey(message: NapCatInboundMessage): string {
  return [
    message.messageId,
    message.senderId,
    message.targetId,
    message.timestamp,
    message.rawBody.trim(),
  ].join("|");
}

function isDuplicateInbound(message: NapCatInboundMessage): boolean {
  const nowMs = Date.now();
  cleanupDedup(nowMs);
  const key = dedupKey(message);
  if (inboundDedup.has(key)) {
    return true;
  }
  inboundDedup.set(key, nowMs);
  return false;
}

function toStringId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSegments(value: unknown): OneBotSegment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is OneBotSegment => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      type: String(entry.type ?? "").trim(),
      data:
        entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
          ? entry.data
          : {},
    }));
}

function decodeCqValue(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]");
}

function extractCqImageUrls(value: string): string[] {
  const mediaUrls: string[] = [];
  const tagRegex = /\[CQ:image,([^\]]*)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(value)) !== null) {
    const payload = match[1] ?? "";
    const params = payload.split(",");
    let urlFromTag = "";
    let fileFromTag = "";
    for (const param of params) {
      const separatorIndex = param.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      const key = param.slice(0, separatorIndex).trim().toLowerCase();
      const rawValue = param.slice(separatorIndex + 1).trim();
      const decodedValue = decodeCqValue(rawValue).trim();
      if (!decodedValue) {
        continue;
      }
      if (key === "url" && !urlFromTag) {
        urlFromTag = decodedValue;
      } else if (key === "file" && !fileFromTag) {
        fileFromTag = decodedValue;
      }
    }
    const resolvedUrl = urlFromTag || fileFromTag;
    if (resolvedUrl) {
      mediaUrls.push(resolvedUrl);
    }
  }
  return mediaUrls;
}

function stripCqSegmentsForCommandBody(value: string): string {
  return value
    // CQ-string payloads inline non-text segments; strip them so command parsing
    // matches structured segment payloads that only expose text content here.
    .replace(/\[CQ:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextAndMedia(params: {
  rawMessage?: string;
  message?: OneBotSegment[] | string;
}): { rawBody: string; commandBody: string; mediaUrls: string[] } {
  const mediaUrls: string[] = [];
  const textParts: string[] = [];

  const segments = normalizeSegments(params.message);
  for (const segment of segments) {
    const type = segment.type.toLowerCase();
    const data = segment.data ?? {};
    if (type === "text") {
      const text = typeof data.text === "string" ? data.text : "";
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (type === "image") {
      const url =
        (typeof data.url === "string" ? data.url : undefined) ??
        (typeof data.file === "string" ? data.file : undefined);
      if (url?.trim()) {
        mediaUrls.push(url.trim());
      }
    }
  }

  if (typeof params.message === "string") {
    mediaUrls.push(...extractCqImageUrls(params.message));
  }
  if (typeof params.rawMessage === "string") {
    mediaUrls.push(...extractCqImageUrls(params.rawMessage));
  }

  const fromSegments = textParts.join("").trim();
  const fromRaw =
    typeof params.message === "string"
      ? params.message.trim()
      : (params.rawMessage?.trim() ?? "");
  const rawBody = fromSegments || fromRaw;

  return {
    rawBody,
    commandBody: stripCqSegmentsForCommandBody(rawBody),
    mediaUrls: Array.from(new Set(mediaUrls)),
  };
}

function resolveSenderName(event: OneBotMessageEvent): string | undefined {
  const senderCard = event.sender?.card;
  if (typeof senderCard === "string" && senderCard.trim()) {
    return senderCard.trim();
  }
  const senderNickname = event.sender?.nickname;
  if (typeof senderNickname === "string" && senderNickname.trim()) {
    return senderNickname.trim();
  }
  const anonymousName = event.anonymous?.name;
  if (typeof anonymousName === "string" && anonymousName.trim()) {
    return anonymousName.trim();
  }
  return undefined;
}

export function isNapCatGroupMessageAllowed(params: {
  groups: Record<string, NapCatGroupConfig> | undefined;
  groupId: string;
  groupPolicy?: GroupPolicy | null;
}): boolean {
  const resolved = resolveNapCatGroupConfig({
    groups: params.groups,
    groupId: params.groupId,
  });
  if (!resolved.matched) {
    return params.groupPolicy !== "disabled";
  }
  if (resolved.enabled === false) {
    return false;
  }
  if (resolved.allow === false) {
    return false;
  }
  return true;
}

export function isNapCatEventMentioningSelf(event: OneBotMessageEvent): boolean {
  const selfId = toStringId(event.self_id);
  if (!selfId) {
    return false;
  }
  const segments = normalizeSegments(event.message);
  if (
    segments.some((segment) => {
      if (segment.type.toLowerCase() !== "at") {
        return false;
      }
      const qq = toStringId(segment.data?.qq);
      return qq === "all" || qq === selfId;
    })
  ) {
    return true;
  }

  const raw =
    typeof event.message === "string"
      ? event.message
      : typeof event.raw_message === "string"
        ? event.raw_message
        : "";
  if (!raw.trim()) {
    return false;
  }

  const selfMention = new RegExp(`\\[CQ:at,[^\\]]*\\bqq=${escapeRegExp(selfId)}(?:,|\\])`, "i");
  const everyoneMention = /\[CQ:at,[^\]]*\bqq=all(?:,|\])/i;
  return selfMention.test(raw) || everyoneMention.test(raw);
}

export function resolveNapCatGroupConfig(params: {
  groups: Record<string, NapCatGroupConfig> | undefined;
  groupId: string;
}): {
  matched: boolean;
  enabled?: boolean;
  allow?: boolean;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
} {
  const groups = params.groups ?? {};
  const exact = groups[params.groupId];
  const wildcard = groups["*"];
  if (!exact && !wildcard) {
    return { matched: false };
  }
  return {
    matched: true,
    enabled: exact?.enabled ?? wildcard?.enabled,
    allow: exact?.allow ?? wildcard?.allow,
    requireMention: exact?.requireMention ?? wildcard?.requireMention,
    allowFrom: exact?.allowFrom ?? wildcard?.allowFrom,
  };
}

export function resolveNapCatCommandAuthorized(params: {
  cfg: OpenClawConfig;
  rawBody: string;
  senderId: string;
  isGroup: boolean;
  configuredAllowFrom: string[];
  configuredGroupAllowFrom: string[];
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
}): boolean | undefined {
  const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  if (!shouldComputeAuth) {
    return undefined;
  }
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const commandAllowFrom = params.isGroup ? params.configuredAllowFrom : params.effectiveAllowFrom;
  const commandGroupAllowFrom = params.isGroup
    ? params.configuredGroupAllowFrom
    : params.effectiveGroupAllowFrom;
  const ownerAllowed = isNapCatSenderAllowed(commandAllowFrom, params.senderId);
  const groupAllowed = isNapCatSenderAllowed(commandGroupAllowFrom, params.senderId);
  return params.resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers: [
      { configured: commandAllowFrom.length > 0, allowed: ownerAllowed },
      { configured: commandGroupAllowFrom.length > 0, allowed: groupAllowed },
    ],
  });
}

export function extractNapCatInboundMessage(event: unknown): NapCatInboundMessage | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const data = event as OneBotMessageEvent;
  if (data.post_type !== "message") {
    return null;
  }
  if (data.message_type !== "private" && data.message_type !== "group") {
    return null;
  }

  const senderId = toStringId(data.user_id || data.sender?.user_id);
  if (!senderId) {
    return null;
  }

  const isGroup = data.message_type === "group";
  const targetId = isGroup ? toStringId(data.group_id) : senderId;
  if (!targetId) {
    return null;
  }

  const timestamp =
    typeof data.time === "number" && Number.isFinite(data.time)
      ? Math.floor(data.time * 1000)
      : Date.now();
  const messageId = toStringId(data.message_id) || `${targetId}:${timestamp}`;
  const { rawBody, commandBody, mediaUrls } = extractTextAndMedia({
    rawMessage: data.raw_message,
    message: data.message,
  });

  if (!rawBody && mediaUrls.length === 0) {
    return null;
  }

  return {
    event: data,
    messageId,
    senderId,
    senderName: resolveSenderName(data),
    isGroup,
    targetId,
    rawBody,
    commandBody,
    mediaUrls,
    selfId: toStringId(data.self_id) || undefined,
    timestamp,
  };
}

export async function processNapCatEvent(params: {
  event: OneBotMessageEvent;
  account: ResolvedNapCatAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
}): Promise<void> {
  params.statusSink?.({ lastEventAt: Date.now() });

  const inbound = extractNapCatInboundMessage(params.event);
  if (!inbound) {
    return;
  }

  if (isDuplicateInbound(inbound)) {
    return;
  }

  const core = getNapCatRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
  });

  const dmPolicy = params.account.config.dm?.policy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.config);
  const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: params.config.channels?.napcat !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy,
  });

  if (
    inbound.isGroup &&
    !isNapCatGroupMessageAllowed({
      groups: params.account.config.groups,
      groupId: inbound.targetId,
      groupPolicy,
    })
  ) {
    params.runtime.log?.(
      `[napcat] dropping group message from ${inbound.targetId} (group blocked by policy)`,
    );
    return;
  }

  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: params.account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });

  const groupConfig = inbound.isGroup
    ? resolveNapCatGroupConfig({
        groups: params.account.config.groups,
        groupId: inbound.targetId,
      })
    : { matched: false as const };
  const configuredAllowFrom = normalizeNapCatAllowFrom(params.account.config.dm?.allowFrom);
  const configuredGroupAllowFrom = normalizeNapCatAllowFrom(
    groupConfig.allowFrom ?? params.account.config.groupAllowFrom ?? params.account.config.dm?.allowFrom,
  );
  const access = resolveDmGroupAccessWithLists({
    isGroup: inbound.isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: params.account.config.dm?.allowFrom ?? [],
    groupAllowFrom:
      groupConfig.allowFrom ?? params.account.config.groupAllowFrom ?? params.account.config.dm?.allowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => isNapCatSenderAllowed(allowFrom, inbound.senderId),
  });
  const commandAuthorized = resolveNapCatCommandAuthorized({
    cfg: params.config,
    rawBody: inbound.commandBody,
    senderId: inbound.senderId,
    isGroup: inbound.isGroup,
    configuredAllowFrom,
    configuredGroupAllowFrom,
    effectiveAllowFrom: access.effectiveAllowFrom,
    effectiveGroupAllowFrom: access.effectiveGroupAllowFrom,
    shouldComputeCommandAuthorized: (rawBody, cfg) =>
      core.channel.commands.shouldComputeCommandAuthorized(rawBody, cfg),
    resolveCommandAuthorizedFromAuthorizers: (commandParams) =>
      core.channel.commands.resolveCommandAuthorizedFromAuthorizers(commandParams),
  });

  if (!inbound.isGroup && access.decision === "pairing") {
    await issuePairingChallenge({
      channel: CHANNEL_ID,
      senderId: inbound.senderId,
      senderIdLine: `Your QQ id: ${inbound.senderId}`,
      meta: { name: inbound.senderName },
      upsertPairingRequest: ({ id, meta }) => pairing.upsertPairingRequest({ id, meta }),
      sendPairingReply: async (text) => {
        await sendNapCatText({
          account: params.account,
          to: `user:${inbound.senderId}`,
          text,
        });
        params.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onReplyError: (err) => {
        params.runtime.error?.(`[napcat] failed to send pairing reply: ${String(err)}`);
      },
    });
    return;
  }

  if (access.decision !== "allow") {
    params.runtime.log?.(
      `[napcat] dropping message from ${inbound.senderId} (reason=${access.reason})`,
    );
    return;
  }

  if (inbound.isGroup) {
    const requireMention = groupConfig.requireMention ?? true;
    if (requireMention && !isNapCatEventMentioningSelf(inbound.event)) {
      return;
    }
  }

  params.statusSink?.({ lastInboundAt: inbound.timestamp });

  const peerKind = inbound.isGroup ? "group" : "direct";
  const peerId = inbound.isGroup ? inbound.targetId : inbound.senderId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: params.config,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: peerKind,
      id: peerId,
    },
  });

  const bodyForAgent = formatTextWithAttachmentLinks(inbound.rawBody, inbound.mediaUrls);
  const fromLabel = inbound.senderName || `qq:${inbound.senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (params.config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    { agentId: route.agentId },
  );
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelope = core.channel.reply.formatAgentEnvelope({
    channel: "NapCat",
    from: fromLabel,
    timestamp: inbound.timestamp,
    previousTimestamp,
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(params.config),
    body: bodyForAgent,
  });

  const toTarget = inbound.isGroup ? `napcat:group:${inbound.targetId}` : `napcat:user:${inbound.senderId}`;
  const context = core.channel.reply.finalizeInboundContext({
    Body: envelope,
    BodyForAgent: bodyForAgent,
    RawBody: inbound.rawBody,
    CommandBody: inbound.commandBody,
    BodyForCommands: inbound.commandBody,
    From: `napcat:user:${inbound.senderId}`,
    To: toTarget,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: inbound.isGroup ? "group" : "direct",
    SenderName: inbound.senderName,
    SenderId: inbound.senderId,
    MessageSid: inbound.messageId,
    Timestamp: inbound.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: toTarget,
    GroupSubject: inbound.isGroup ? inbound.targetId : undefined,
    CommandAuthorized: commandAuthorized,
    MediaUrl: inbound.mediaUrls[0],
    MediaUrls: inbound.mediaUrls.length > 0 ? inbound.mediaUrls : undefined,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: context.SessionKey ?? route.sessionKey,
    ctx: context,
    onRecordError: (err) => {
      params.runtime.error?.(`[napcat] failed to update session metadata: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: params.config,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
  });

  const outboundTarget = inbound.isGroup ? `group:${inbound.targetId}` : `user:${inbound.senderId}`;
  const deliver = createNormalizedOutboundDeliverer(async (payload) => {
    const text = payload.text?.trim() ?? "";
    const mediaUrls = resolveOutboundMediaUrls(payload);
    if (!text && mediaUrls.length === 0) {
      return;
    }

    if (mediaUrls.length === 0) {
      await sendNapCatText({
        account: params.account,
        to: outboundTarget,
        text,
        replyToId: payload.replyToId,
      });
      params.statusSink?.({ lastOutboundAt: Date.now() });
      return;
    }

    let first = true;
    for (const mediaUrl of mediaUrls) {
      await sendNapCatMedia({
        account: params.account,
        to: outboundTarget,
        mediaUrl,
        caption: first ? text : "",
        replyToId: first ? payload.replyToId : undefined,
      });
      first = false;
      params.statusSink?.({ lastOutboundAt: Date.now() });
    }
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: context,
    cfg: params.config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver,
      onError: (err, info) => {
        params.runtime.error?.(`[napcat] ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      disableBlockStreaming:
        typeof params.account.config.blockStreaming === "boolean"
          ? !params.account.config.blockStreaming
          : undefined,
    },
  });
}

export function normalizeNapCatAllowFrom(entries: Array<string | number> | undefined): string[] {
  const normalized = (entries ?? [])
    .map((entry) => normalizeNapCatAllowEntry(String(entry)))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}
