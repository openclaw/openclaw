import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { type ChannelMessageSendPayloadContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  avatar,
  rename,
  reply,
  type Content,
  type ContentBuilder,
  type Message,
  type Space,
  type SpectrumInstance,
} from "spectrum-ts";
import {
  background,
  customizedMiniApp,
  effect,
  imessage,
  nativeContactCard,
} from "spectrum-ts/providers/imessage";
import { resolveSpectrumAccount, type ResolvedSpectrumAccount } from "./accounts.js";
import { buildSpectrumFormattedContent } from "./format.runtime.js";
import {
  buildSpectrumInboundMediaPayload,
  buildSpectrumOutboundMediaContent,
  extractSpectrumInboundMedia,
} from "./media.runtime.js";
import { sendSpectrumTyping } from "./typing.runtime.js";

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[imessage-spectrum] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err: Error) => {
  console.error("[imessage-spectrum] Uncaught exception:", err);
});

const processedIds = new Set<string>();
const inFlightMessageIds = new Set<string>();
const bootContextInjected = new Set<string>();
const DEFAULT_SESSION_CONTEXT =
  "You are speaking with the user via iMessage. Be brief, useful, and aware that mobile replies may be delayed.";
const CHANNEL = "imessage-spectrum" as const;
const CATCHUP_NAMESPACE = "imessage-spectrum.catchup";
const CATCHUP_KEY = "default";
const RECENT_MESSAGE_SPACE_TTL_MS = 60 * 60 * 1000;
const RECENT_MESSAGE_SPACE_MAX = 1000;

type QueuedOutbound = {
  id: string;
  spaceId: string;
  text: string;
  mediaUrl?: string;
  replyToId?: string;
  audioAsVoice?: boolean;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  createdAt: number;
  accountId: string;
  lastError?: string;
};

type PersistedCatchupCursor = {
  lastProcessedMessageId?: string;
  lastProcessedMessageAt?: number;
  updatedAt: number;
};

const outboundQueue: QueuedOutbound[] = [];
let queueDrainTimer: ReturnType<typeof setInterval> | null = null;
let lastInboundAt: number | null = null;
let lastInboundSpaceId: string | null = null;
let lastInboundReaction: {
  emoji: string;
  messageId: string;
  senderId: string;
  at: number;
} | null = null;
const recentMessageSpaces = new Map<string, { spaceId: string; at: number }>();
let lastOutboundAt: number | null = null;
let lastOutboundSpaceId: string | null = null;
let lastDeliveryError: string | null = null;

setInterval(() => {}, 30000);

let app: SpectrumInstance | null = null;
let appConfigKey: string | null = null;
let imsgPlatform: {
  space: { get: (id: string) => Promise<Space> };
  user: (target: string) => Promise<{ id: string }>;
  typing?: (space: Space) => Promise<unknown>;
} | null = null;
let cloudflaredProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let streamStatus: "idle" | "starting" | "connected" | "reconnecting" | "stopped" = "idle";
let lastStreamError: string | null = null;
let streamRestartAttempts = 0;
let streamGeneration = 0;
let streamRestartTimer: ReturnType<typeof setTimeout> | null = null;
let catchupTimer: ReturnType<typeof setInterval> | null = null;
let catchupInFlight = false;
let appInitPromise: Promise<SpectrumInstance> | null = null;
let runtimeApi: OpenClawPluginApi | null = null;

function readCurrentOpenClawConfig(api?: OpenClawPluginApi | null): OpenClawConfig {
  return (api?.runtime?.config?.current?.() ??
    runtimeApi?.runtime?.config?.current?.() ??
    api?.config ??
    runtimeApi?.config ??
    ({} as OpenClawConfig)) as OpenClawConfig;
}

async function loadCurrentOpenClawConfig(api?: OpenClawPluginApi | null): Promise<OpenClawConfig> {
  const cfg =
    api?.runtime?.config?.current?.() ??
    runtimeApi?.runtime?.config?.current?.() ??
    api?.config ??
    runtimeApi?.config;
  if (cfg) {
    return cfg as OpenClawConfig;
  }
  const { getRuntimeConfig } = await import("openclaw/plugin-sdk/runtime-config-snapshot");
  return getRuntimeConfig() as OpenClawConfig;
}

function resolveCurrentSpectrumAccount(
  api?: OpenClawPluginApi | null,
  accountId?: string | null,
): ResolvedSpectrumAccount {
  return resolveSpectrumAccount({ cfg: readCurrentOpenClawConfig(api), accountId });
}

function spectrumAppConfigKey(account: ResolvedSpectrumAccount): string {
  return [
    account.accountId,
    account.projectId,
    account.projectSecret,
    account.webhookSecret,
    account.enabled ? "1" : "0",
  ].join("\u0000");
}

async function disposeSpectrumApp(): Promise<void> {
  const previous = app;
  app = null;
  imsgPlatform = null;
  appConfigKey = null;
  appInitPromise = null;
  if (previous) {
    await previous.stop().catch((err: unknown) => {
      console.warn("[imessage-spectrum] failed to stop previous Spectrum app:", err);
    });
  }
}

// ─── iMessage feature constants ───────────────────────────────────────

const SPECTRUM_EFFECTS = {
  slam: imessage.effect.message.slam,
  loud: imessage.effect.message.loud,
  gentle: imessage.effect.message.gentle,
  invisible: imessage.effect.message.invisible,
  confetti: imessage.effect.message.confetti,
  fireworks: imessage.effect.message.fireworks,
  balloons: imessage.effect.message.balloons,
  heart: imessage.effect.message.heart,
  lasers: imessage.effect.message.lasers,
  celebration: imessage.effect.message.celebration,
  sparkles: imessage.effect.message.sparkles,
  spotlight: imessage.effect.message.spotlight,
  echo: imessage.effect.message.echo,
} as const;

type SpectrumEffectName = keyof typeof SPECTRUM_EFFECTS;

const SPECTRUM_EFFECT_ALIASES: Record<string, SpectrumEffectName> = {
  slam: "slam",
  loud: "loud",
  gentle: "gentle",
  invisible: "invisible",
  invisible_ink: "invisible",
  invisibleink: "invisible",
  confetti: "confetti",
  fireworks: "fireworks",
  balloons: "balloons",
  balloon: "balloons",
  heart: "heart",
  love: "heart",
  lasers: "lasers",
  laser: "lasers",
  celebration: "celebration",
  birthday: "celebration",
  happy_birthday: "celebration",
  sparkles: "sparkles",
  sparkle: "sparkles",
  spotlight: "spotlight",
  echo: "echo",
};

/** iMessage tapback reaction constants. Use with `message.react()`. */
export const SPECTRUM_TAPBACKS = {
  love: "love",
  like: "like",
  dislike: "dislike",
  laugh: "laugh",
  emphasize: "emphasize",
  question: "question",
} as const;

const SPECTRUM_TAPBACK_TO_REACTION: Record<string, string> = {
  love: "❤️",
  heart: "❤️",
  like: "👍",
  thumbs_up: "👍",
  thumbsup: "👍",
  dislike: "👎",
  thumbs_down: "👎",
  thumbsdown: "👎",
  laugh: "😂",
  haha: "😂",
  emphasize: "‼️",
  exclamation: "‼️",
  question: "❓",
};

// ─── tunnel / helpers ─────────────────────────────────────────────────

export function getTunnelUrl(): string | null {
  return tunnelUrl;
}

function getWebhookUrl(): string | null {
  return tunnelUrl ? `${tunnelUrl}/channels/imessage-spectrum/webhook` : null;
}

function resolveWebhookBase(api: OpenClawPluginApi): string | null {
  const account = resolveCurrentSpectrumAccount(api);
  return account.webhookBaseUrl || null;
}

function isChatGuid(value: string): boolean {
  return value.startsWith("any;-;") || value.startsWith("any;+;");
}

type NormalizedSpectrumTarget = { kind: "space"; id: string } | { kind: "user"; target: string };

export function normalizeSpectrumTarget(to: string): NormalizedSpectrumTarget {
  let target = to.trim();
  if (!target) {
    throw new Error("iMessage Spectrum target is required");
  }

  if (target.startsWith(`${CHANNEL}://`)) {
    target = target.slice(`${CHANNEL}://`.length).trim();
  } else if (target.startsWith(`${CHANNEL}:`)) {
    target = target.slice(`${CHANNEL}:`.length).trim();
  }

  const spacePrefixes = ["group:", "space:", "chat:", "conversation:"];
  for (const prefix of spacePrefixes) {
    if (target.startsWith(prefix)) {
      const id = target.slice(prefix.length).trim();
      if (!id) {
        throw new Error("iMessage Spectrum space target is required");
      }
      return { kind: "space", id };
    }
  }

  const userPrefixes = ["direct:", "user:", "phone:", "address:"];
  for (const prefix of userPrefixes) {
    if (target.startsWith(prefix)) {
      target = target.slice(prefix.length).trim();
      break;
    }
  }

  if (!target) {
    throw new Error("iMessage Spectrum target is required");
  }
  if (isChatGuid(target)) {
    return { kind: "space", id: target };
  }
  return { kind: "user", target };
}

export function normalizeSpectrumTapback(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const key = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return SPECTRUM_TAPBACK_TO_REACTION[key] ?? trimmed;
}

export function normalizeSpectrumEffectName(value: unknown): SpectrumEffectName | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return key ? SPECTRUM_EFFECT_ALIASES[key] : undefined;
}

function readOptionalStringProperty(
  value: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" || typeof raw === "number") {
      const normalized = String(raw).trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNestedRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const nested = value[key];
    if (isRecord(nested)) {
      return nested;
    }
  }
  return undefined;
}

function readReplyTargetIdFromContent(content: unknown): string | undefined {
  if (!isRecord(content) || content.type !== "reply") {
    return undefined;
  }
  const target = isRecord(content.target) ? content.target : undefined;
  return readOptionalStringProperty(target, ["id", "messageId", "guid"]);
}

export function resolveSpectrumPayloadEffectName(
  payload: Record<string, unknown> | null | undefined,
): SpectrumEffectName | undefined {
  return normalizeSpectrumEffectName(
    readOptionalStringProperty(payload, [
      "effectName",
      "effect_name",
      "effectId",
      "effect_id",
      "effect",
      "imessageEffect",
      "imessage_effect",
      "iMessageEffect",
    ]),
  );
}

export function resolveSpectrumInboundThreadReplyToId(message: Message): string | undefined {
  const topLevel = message as Message & Record<string, unknown>;
  const contentReplyTargetId = readReplyTargetIdFromContent(message.content);
  if (contentReplyTargetId) {
    return contentReplyTargetId;
  }

  const explicitTopLevel = readOptionalStringProperty(topLevel, [
    "replyToId",
    "replyToMessageId",
    "replyToGuid",
    "inReplyToId",
    "inReplyToGuid",
    "threadParentId",
    "threadParentGuid",
  ]);
  if (explicitTopLevel) {
    return explicitTopLevel;
  }

  const content = isRecord(message.content) ? message.content : undefined;
  const nestedSources = [
    content,
    readNestedRecord(content, ["raw", "message", "event", "payload", "metadata"]),
    readNestedRecord(topLevel, ["raw", "message", "event", "payload", "metadata"]),
  ].filter((value): value is Record<string, unknown> => Boolean(value));

  for (const source of nestedSources) {
    const nested = readOptionalStringProperty(source, [
      "replyToId",
      "replyToMessageId",
      "replyToGuid",
      "inReplyToId",
      "inReplyToGuid",
      "threadParentId",
      "threadParentGuid",
      "associatedMessageGuid",
    ]);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function resolveExplicitContextReplyToId(ctx: {
  replyToId?: unknown;
  replyToIdSource?: "explicit" | "implicit";
  payload?: { replyToId?: unknown } | null;
}): string | undefined {
  const directReplyToId =
    typeof ctx.replyToId === "string" || typeof ctx.replyToId === "number"
      ? String(ctx.replyToId).trim()
      : "";
  if (!directReplyToId || ctx.replyToIdSource === "implicit") {
    return undefined;
  }
  if (ctx.replyToIdSource === "explicit") {
    return directReplyToId;
  }
  if (ctx.payload && Object.prototype.hasOwnProperty.call(ctx.payload, "replyToId")) {
    const payloadReplyToId = ctx.payload.replyToId;
    if (typeof payloadReplyToId === "string" || typeof payloadReplyToId === "number") {
      const normalized = String(payloadReplyToId).trim();
      return normalized || undefined;
    }
  }
  return undefined;
}

export function resolveSpectrumDeliveryReplyToId(params: {
  payload?: { replyToId?: unknown } | null;
  inboundThreadReplyToId?: string;
}): string | undefined {
  if (
    params.payload &&
    Object.prototype.hasOwnProperty.call(params.payload, "replyToId") &&
    params.payload.replyToId === null
  ) {
    return undefined;
  }
  const explicitPayload = readOptionalStringProperty(
    params.payload as Record<string, unknown> | null | undefined,
    ["replyToId"],
  );
  return explicitPayload ?? params.inboundThreadReplyToId;
}

function rememberMessageSpace(messageId: string, spaceId: string): void {
  if (!messageId || !spaceId) {
    return;
  }
  const now = Date.now();
  recentMessageSpaces.set(messageId, { spaceId, at: now });
  for (const [id, entry] of recentMessageSpaces) {
    if (
      recentMessageSpaces.size <= RECENT_MESSAGE_SPACE_MAX &&
      now - entry.at <= RECENT_MESSAGE_SPACE_TTL_MS
    ) {
      continue;
    }
    recentMessageSpaces.delete(id);
  }
}

function resolveRememberedMessageSpace(messageId: string): string | null {
  const entry = recentMessageSpaces.get(messageId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.at > RECENT_MESSAGE_SPACE_TTL_MS) {
    recentMessageSpaces.delete(messageId);
    return null;
  }
  return entry.spaceId;
}

function describeSpectrumMedia(content: {
  type?: string;
  caption?: unknown;
  description?: unknown;
}): string {
  if (content.type === "image") {
    return typeof content.caption === "string" && content.caption.trim()
      ? content.caption
      : "[Image]";
  }
  if (content.type === "video") {
    return typeof content.caption === "string" && content.caption.trim()
      ? content.caption
      : "[Video]";
  }
  if (content.type === "audio") {
    if (typeof content.caption === "string" && content.caption.trim()) {
      return content.caption;
    }
    if (typeof content.description === "string" && content.description.trim()) {
      return content.description;
    }
    return "[Audio]";
  }
  return "";
}

function extractInboundText(content: Content): string {
  if (content.type === "text") return content.text;
  if (content.type === "markdown") return content.markdown;
  return describeSpectrumMedia(
    content as { type?: string; caption?: unknown; description?: unknown },
  );
}

function recordInboundReaction(message: Message, senderId: string): void {
  const content = message.content as {
    type?: string;
    emoji?: string;
    reaction?: string;
    targetId?: string;
    messageId?: string;
  };
  if (content.type !== "reaction") {
    return;
  }
  const emoji = content.emoji ?? content.reaction ?? "";
  if (!emoji) {
    return;
  }
  lastInboundReaction = {
    emoji,
    messageId: content.targetId ?? content.messageId ?? message.id,
    senderId,
    at: Date.now(),
  };
}

function resolveSpectrumFrom(params: {
  senderId: string;
  spaceId: string;
  isGroup: boolean;
}): string {
  return params.isGroup ? `${CHANNEL}:group:${params.spaceId}` : `${CHANNEL}:${params.senderId}`;
}

function resolveSpectrumTo(params: {
  senderId: string;
  spaceId: string;
  isGroup: boolean;
}): string {
  return params.isGroup ? `${CHANNEL}:group:${params.spaceId}` : `${CHANNEL}:${params.senderId}`;
}

function buildSpectrumInboundSessionKey(params: {
  agentId: string;
  accountId: string;
  peerId: string;
  isGroup: boolean;
  identityLinks?: Record<string, string[]>;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: CHANNEL,
    accountId: params.accountId,
    peer: { kind: params.isGroup ? "group" : "direct", id: params.peerId },
    dmScope: "per-account-channel-peer",
    identityLinks: params.identityLinks,
  });
}

export function resolveSpectrumGatewayPort(api: OpenClawPluginApi): number {
  const cfg = readCurrentOpenClawConfig(api);
  const account = resolveSpectrumAccount({ cfg });
  if (account.tunnelPort) return account.tunnelPort;
  const gatewayPort = cfg.gateway?.port;
  if (typeof gatewayPort === "number" && gatewayPort > 0) return gatewayPort;
  return 18789;
}

function openCatchupStore(
  api: OpenClawPluginApi,
): PluginStateSyncKeyedStore<PersistedCatchupCursor> {
  return api.runtime.state.openSyncKeyedStore<PersistedCatchupCursor>({
    namespace: CATCHUP_NAMESPACE,
    maxEntries: 16,
  });
}

function readCatchupCursor(api: OpenClawPluginApi): PersistedCatchupCursor | null {
  try {
    return openCatchupStore(api).lookup(CATCHUP_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveCatchupCursor(
  api: OpenClawPluginApi,
  lastProcessedMessageId: string,
  lastProcessedMessageAt?: number,
): void {
  openCatchupStore(api).register(CATCHUP_KEY, {
    lastProcessedMessageId,
    ...(lastProcessedMessageAt != null ? { lastProcessedMessageAt } : {}),
    updatedAt: Date.now(),
  });
}

// ─── Spectrum lifecycle ───────────────────────────────────────────────

async function ensureApp(force = false): Promise<SpectrumInstance> {
  const cfg = await loadCurrentOpenClawConfig(runtimeApi);
  const account = resolveSpectrumAccount({ cfg });
  if (!account.enabled) {
    throw new Error("iMessage Spectrum account is disabled");
  }
  if (!account.configured) {
    throw new Error("iMessage Spectrum projectId/projectSecret are not configured");
  }

  const nextConfigKey = spectrumAppConfigKey(account);
  if (app && imsgPlatform && !force && appConfigKey === nextConfigKey) {
    return app;
  }

  if (app || force || (appConfigKey && appConfigKey !== nextConfigKey)) {
    await disposeSpectrumApp();
  }

  if (!app) {
    const { Spectrum } = await import("spectrum-ts");
    const { imessage } = await import("spectrum-ts/providers/imessage");
    const MAX_RETRIES = 3;
    const BASE_DELAY = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        app = await Spectrum({
          projectId: account.projectId,
          projectSecret: account.projectSecret,
          providers: [imessage.config({ local: false })],
          ...(account.webhookSecret ? { webhookSecret: account.webhookSecret } : {}),
        });
        imsgPlatform = imessage(app) as typeof imsgPlatform;
        appConfigKey = nextConfigKey;
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, attempt - 1);
          console.error(
            `[imessage-spectrum] ensureApp attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms:`,
            err,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.error(`[imessage-spectrum] ensureApp failed after ${MAX_RETRIES} attempts:`, err);
          throw err;
        }
      }
    }
  }
  if (!app || !imsgPlatform) {
    throw new Error("Spectrum app failed to initialize");
  }
  return app;
}

async function ensureAppDeduped(force = false): Promise<SpectrumInstance> {
  if (force) {
    appInitPromise = null;
    return ensureApp(true);
  }
  if (app && imsgPlatform) {
    return ensureApp(false);
  }
  if (!appInitPromise) {
    appInitPromise = ensureApp().then(
      (initialized) => {
        appInitPromise = null;
        return initialized;
      },
      (err) => {
        appInitPromise = null;
        throw err;
      },
    );
  }
  return appInitPromise;
}

async function resolveSpectrumSpace(to: string) {
  await ensureApp();
  if (!imsgPlatform) {
    throw new Error("Spectrum platform unavailable");
  }
  const target = normalizeSpectrumTarget(to);
  if (target.kind === "space") {
    return await imsgPlatform.space.get(target.id);
  }
  const user = await imsgPlatform.user(target.target);
  return await imsgPlatform.space.get(`any;-;${user.id}`);
}

// ─── text command parsing ─────────────────────────────────────────────

function parseCommandsFromText(text: string): {
  effectName?: SpectrumEffectName;
  cleanText: string;
  contentOverride?: ContentBuilder;
} {
  if (!text) return { cleanText: text };
  const lines = text.trim().split("\n");
  const firstLine = lines[0].trim();

  if (firstLine.startsWith("!!")) {
    const spaceIndex = firstLine.indexOf(" ");
    const command =
      spaceIndex === -1
        ? firstLine.substring(2).toLowerCase()
        : firstLine.substring(2, spaceIndex).toLowerCase();
    const args = spaceIndex === -1 ? "" : firstLine.substring(spaceIndex + 1).trim();
    const restText = lines.slice(1).join("\n").trim();
    const normalizedEffect = normalizeSpectrumEffectName(command);

    if (normalizedEffect) {
      return {
        effectName: normalizedEffect,
        cleanText: args + (restText ? `\n${restText}` : ""),
      };
    }
    if (command === "effect" || command === "fx") {
      const [effectCandidate = "", ...messageParts] = args.split(/\s+/);
      const effectName = normalizeSpectrumEffectName(effectCandidate);
      if (effectName) {
        const messageText = messageParts.join(" ").trim();
        return {
          effectName,
          cleanText: messageText + (restText ? `\n${restText}` : ""),
        };
      }
    }
    if (command === "rename") {
      return { contentOverride: rename(args), cleanText: restText };
    }
    if (command === "avatar") {
      return { contentOverride: avatar(args), cleanText: restText };
    }
    if (command === "background") {
      return { contentOverride: background(args), cleanText: restText };
    }
    if (command === "contactcard") {
      return { contentOverride: nativeContactCard(), cleanText: restText };
    }
    if (command === "miniapp") {
      try {
        const json = JSON.parse(args || "{}");
        return { contentOverride: customizedMiniApp(json), cleanText: restText };
      } catch (err) {
        console.error("[imessage-spectrum] failed to parse miniapp JSON:", err);
      }
    }
  }

  const match = text.match(/^!!(\w+)\s+(.+)/s);
  const inlineEffectName = match ? normalizeSpectrumEffectName(match[1]) : undefined;
  if (match && inlineEffectName) {
    return {
      effectName: inlineEffectName,
      cleanText: match[2].trim(),
    };
  }

  return { cleanText: text };
}

// ─── content building / sending ───────────────────────────────────────

async function sendContentToSpace(params: {
  spaceId: string;
  text: string;
  mediaUrl?: string;
  replyToId?: string | null;
  audioAsVoice?: boolean;
  forceFresh?: boolean;
  /** Direct ContentBuilder override (takes priority over text/media + command parsing). */
  contentBuilder?: ContentBuilder;
  /** Effect name to wrap the text/media content in. Ignored when contentBuilder is set. */
  effectName?: string;
}): Promise<{ messageId: string }> {
  const client = await ensureApp(params.forceFresh);
  if (!imsgPlatform) {
    throw new Error("Spectrum platform unavailable");
  }
  const space = await imsgPlatform.space.get(params.spaceId);
  let baseContent: ContentBuilder;
  if (params.contentBuilder) {
    baseContent = params.contentBuilder;
  } else if (params.mediaUrl && params.mediaUrl.trim()) {
    const resolvedEffect = normalizeSpectrumEffectName(params.effectName);
    baseContent = buildSpectrumOutboundMediaContent({
      mediaUrl: params.mediaUrl.trim(),
      audioAsVoice: params.audioAsVoice && !resolvedEffect,
    });
    if (resolvedEffect) {
      baseContent = effect(baseContent, SPECTRUM_EFFECTS[resolvedEffect]);
    }
  } else {
    const {
      effectName: cmdEffectName,
      cleanText,
      contentOverride,
    } = parseCommandsFromText(params.text);
    const resolvedEffect = normalizeSpectrumEffectName(params.effectName) ?? cmdEffectName;
    if (contentOverride) {
      baseContent = contentOverride;
    } else if (resolvedEffect) {
      baseContent = effect(
        buildSpectrumFormattedContent(cleanText || params.text),
        SPECTRUM_EFFECTS[resolvedEffect],
      );
    } else {
      baseContent = buildSpectrumFormattedContent(cleanText || params.text);
    }
  }
  let content: ContentBuilder = baseContent;
  if (params.replyToId?.trim()) {
    const replyToId = params.replyToId.trim();
    try {
      const target = await space.getMessage(replyToId);
      if (target) {
        content = reply(baseContent, target);
      } else {
        console.warn(
          `[imessage-spectrum] reply target not found for ${replyToId}, sending as new message`,
        );
      }
    } catch (err) {
      console.warn(
        `[imessage-spectrum] reply target lookup failed for ${replyToId}, sending as new message: ${String(err)}`,
      );
    }
  }
  const result = await client.send(space, content);
  lastOutboundAt = Date.now();
  lastOutboundSpaceId = params.spaceId;
  lastDeliveryError = null;
  const messageId = result?.id ?? "unknown";
  rememberMessageSpace(messageId, params.spaceId);
  return { messageId };
}

function ensureQueueDrain(api: OpenClawPluginApi): void {
  if (queueDrainTimer) return;
  queueDrainTimer = setInterval(() => {
    void drainOutboundQueue(api);
  }, 5000);
}

function enqueueOutbound(params: {
  api: OpenClawPluginApi;
  account: ResolvedSpectrumAccount;
  spaceId: string;
  text: string;
  mediaUrl?: string;
  replyToId?: string;
  audioAsVoice?: boolean;
  error: unknown;
}): void {
  if (params.account.deliveryQueueSize <= 0) return;
  outboundQueue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    spaceId: params.spaceId,
    text: params.text,
    mediaUrl: params.mediaUrl,
    replyToId: params.replyToId,
    audioAsVoice: params.audioAsVoice,
    attempts: 0,
    maxAttempts: params.account.deliveryRetryCount,
    nextAttemptAt: Date.now() + params.account.deliveryRetryDelayMs,
    createdAt: Date.now(),
    accountId: params.account.accountId,
    lastError: String(params.error),
  });
  while (outboundQueue.length > params.account.deliveryQueueSize) {
    outboundQueue.shift();
  }
  ensureQueueDrain(params.api);
}

async function drainOutboundQueue(api: OpenClawPluginApi): Promise<void> {
  if (outboundQueue.length === 0) return;
  const now = Date.now();
  for (const queued of [...outboundQueue]) {
    if (queued.nextAttemptAt > now) continue;
    queued.attempts += 1;
    try {
      await sendContentToSpace({
        spaceId: queued.spaceId,
        text: queued.text,
        mediaUrl: queued.mediaUrl,
        replyToId: queued.replyToId,
        audioAsVoice: queued.audioAsVoice,
        forceFresh: true,
      });
      const index = outboundQueue.findIndex((item) => item.id === queued.id);
      if (index >= 0) outboundQueue.splice(index, 1);
      api.logger.info?.(
        `[imessage-spectrum] delivered queued outbound ${queued.id} after ${queued.attempts} attempt(s)`,
      );
    } catch (err) {
      queued.lastError = String(err);
      lastDeliveryError = queued.lastError;
      if (queued.attempts >= queued.maxAttempts) {
        const index = outboundQueue.findIndex((item) => item.id === queued.id);
        if (index >= 0) outboundQueue.splice(index, 1);
        api.logger.error?.(
          `[imessage-spectrum] dropped queued outbound ${queued.id} after ${queued.attempts} attempt(s): ${queued.lastError}`,
        );
      } else {
        queued.nextAttemptAt = Date.now() + Math.min(60000, 1000 * Math.pow(2, queued.attempts));
      }
    }
  }
}

function scheduleStreamRestart(api: OpenClawPluginApi): void {
  if (streamRestartTimer) {
    return;
  }
  streamRestartAttempts += 1;
  const delay = Math.min(60000, 1000 * Math.pow(2, Math.min(streamRestartAttempts, 6)));
  streamRestartTimer = setTimeout(() => {
    streamRestartTimer = null;
    if (streamStatus === "stopped") {
      return;
    }
    streamStatus = "idle";
    ensureSpectrumMessageStream(api);
  }, delay);
}

async function runSpectrumMessageStreamLoop(
  api: OpenClawPluginApi,
  generation: number,
): Promise<void> {
  try {
    const client = await ensureAppDeduped();
    streamStatus = "connected";
    streamRestartAttempts = 0;
    lastStreamError = null;

    for await (const [space, message] of client.messages) {
      if (generation !== streamGeneration) {
        return;
      }
      const account = resolveCurrentSpectrumAccount(api);
      if (!account.enabled || !account.configured) {
        continue;
      }
      await dispatchSpectrumInboundEvent({
        api,
        account,
        space,
        message,
        replySpace: space,
        client,
        source: "stream",
      });
    }
    if (generation === streamGeneration) {
      streamStatus = "reconnecting";
      scheduleStreamRestart(api);
    }
  } catch (err) {
    if (generation !== streamGeneration) {
      return;
    }
    lastStreamError = String(err);
    streamStatus = "reconnecting";
    api.logger.warn?.(`[imessage-spectrum] message stream error: ${lastStreamError}`);
    scheduleStreamRestart(api);
  }
}

function ensureSpectrumMessageStream(api: OpenClawPluginApi): void {
  const account = resolveCurrentSpectrumAccount(api);
  if (!account.enabled || !account.configured) {
    lastStreamError = !account.enabled
      ? "iMessage Spectrum account is disabled"
      : "iMessage Spectrum projectId/projectSecret are not configured";
    return;
  }
  if (streamStatus === "connected") {
    return;
  }
  if (streamStatus === "starting") {
    return;
  }
  if (streamStatus === "stopped") {
    return;
  }
  if (streamStatus === "reconnecting" && streamRestartTimer) {
    return;
  }

  streamStatus = "starting";
  const generation = streamGeneration;
  void runSpectrumMessageStreamLoop(api, generation);
}

function ensurePeriodicCatchup(api: OpenClawPluginApi): void {
  if (catchupTimer) {
    return;
  }
  const account = resolveCurrentSpectrumAccount(api);
  if (!account.enabled || !account.configured || account.config.catchup?.enabled === false) {
    return;
  }
  catchupTimer = setInterval(() => {
    void (async () => {
      try {
        const client = await ensureAppDeduped();
        const currentAccount = resolveCurrentSpectrumAccount(api);
        if (!currentAccount.enabled || !currentAccount.configured) {
          return;
        }
        await performSpectrumCatchup({ api, account: currentAccount, client });
      } catch (err) {
        api.logger.warn?.(`[imessage-spectrum] periodic catchup failed: ${String(err)}`);
      }
    })();
  }, account.catchupIntervalMs);
}

function saveCatchupCursorForMessage(api: OpenClawPluginApi, message: Message): void {
  saveCatchupCursor(api, message.id, message.timestamp?.getTime?.());
}

// ─── cloudflared tunnel ───────────────────────────────────────────────

export function startCloudflaredTunnel(gatewayPort: number, api: OpenClawPluginApi): void {
  if (cloudflaredProcess) {
    api.logger.info?.("[imessage-spectrum] cloudflared already running, skipping");
    return;
  }
  const proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${gatewayPort}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onStderr = (data: Buffer) => {
    const line = data.toString();
    const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (!match) return;
    tunnelUrl = match[0];
    proc.stderr?.off("data", onStderr);
    api.logger.info?.(`[imessage-spectrum] tunnel ready at ${tunnelUrl}`);
    api.logger.info?.(`[imessage-spectrum] webhook URL: ${getWebhookUrl()}`);
    api.logger.info?.(
      "[imessage-spectrum] Register this URL with Photon and set channels.imessage-spectrum.webhookSecret to the returned signingSecret.",
    );
  };
  proc.stderr?.on("data", onStderr);
  proc.on("error", (err) => {
    api.logger.error?.("[imessage-spectrum] cloudflared failed: " + err.message);
  });
  proc.on("exit", (code) => {
    if (!tunnelUrl) {
      api.logger.warn?.(
        `[imessage-spectrum] cloudflared exited (code ${code}) before producing URL`,
      );
    }
    cloudflaredProcess = null;
  });
  cloudflaredProcess = proc;
}

export function stopSpectrumRuntime(): void {
  streamGeneration += 1;
  streamStatus = "stopped";
  if (streamRestartTimer) {
    clearTimeout(streamRestartTimer);
    streamRestartTimer = null;
  }
  if (catchupTimer) {
    clearInterval(catchupTimer);
    catchupTimer = null;
  }
  if (cloudflaredProcess) {
    cloudflaredProcess.kill("SIGTERM");
    cloudflaredProcess = null;
  }
  if (queueDrainTimer) {
    clearInterval(queueDrainTimer);
    queueDrainTimer = null;
  }
  const currentApp = app;
  tunnelUrl = null;
  app = null;
  appConfigKey = null;
  imsgPlatform = null;
  appInitPromise = null;
  runtimeApi = null;
  if (currentApp) {
    void currentApp.stop().catch((err: unknown) => {
      console.warn("[imessage-spectrum] failed to stop Spectrum app:", err);
    });
  }
}

// ─── public outbound API ──────────────────────────────────────────────

export async function sendSpectrumOutbound(params: {
  to: string;
  text: string;
}): Promise<{ messageId: string }> {
  const space = await resolveSpectrumSpace(params.to);
  return await sendContentToSpace({ spaceId: space.id, text: params.text });
}

export async function sendSpectrumOutboundPayload(params: {
  to: string;
  text: string;
  mediaUrl?: string;
  replyToId?: string | null;
  audioAsVoice?: boolean;
  contentBuilder?: ContentBuilder;
  effectName?: string;
}): Promise<{ messageId: string }> {
  const space = await resolveSpectrumSpace(params.to);
  return await sendContentToSpace({
    spaceId: space.id,
    text: params.text,
    mediaUrl: params.mediaUrl,
    replyToId: params.replyToId,
    audioAsVoice: params.audioAsVoice,
    contentBuilder: params.contentBuilder,
    effectName: params.effectName,
  });
}

export async function sendSpectrumPayload(ctx: ChannelMessageSendPayloadContext): Promise<{
  receipt: {
    platformMessageIds: string[];
    parts: Array<{ index: number; kind: "text" | "media"; platformMessageId: string }>;
    sentAt: number;
    replyToId?: string;
  };
  messageId: string;
}> {
  const payload = ctx.payload ?? {};
  const rawPayload = payload as Record<string, unknown>;
  const contentOverride = buildSpectrumPayloadContent(rawPayload);
  const explicitReplyToId = resolveExplicitContextReplyToId({
    replyToId: ctx.replyToId,
    replyToIdSource: (ctx as { replyToIdSource?: "explicit" | "implicit" }).replyToIdSource,
    payload: rawPayload as { replyToId?: unknown },
  });

  // Standalone content builders (mini-app, contact card, rename, avatar, background)
  // take priority over text/media.
  if (contentOverride) {
    const delivery = await sendSpectrumOutboundPayload({
      to: ctx.to,
      text: "",
      contentBuilder: contentOverride,
      replyToId: explicitReplyToId,
    });
    return {
      receipt: {
        platformMessageIds: [delivery.messageId],
        parts: [{ index: 0, kind: "text", platformMessageId: delivery.messageId }],
        sentAt: Date.now(),
        ...(explicitReplyToId ? { replyToId: explicitReplyToId } : {}),
      },
      messageId: delivery.messageId,
    };
  }

  const effectName = resolveSpectrumPayloadEffectName(rawPayload);
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()
      ? [payload.mediaUrl.trim()]
      : [];
  const parts: Array<{ index: number; kind: "text" | "media"; platformMessageId: string }> = [];
  let lastMessageId = "";

  if (mediaUrls.length > 0) {
    for (const [index, mediaUrl] of mediaUrls.entries()) {
      const delivery = await sendSpectrumOutboundPayload({
        to: ctx.to,
        text: index === 0 ? (payload.text ?? "") : "",
        mediaUrl,
        replyToId: index === 0 ? explicitReplyToId : undefined,
        audioAsVoice: payload.audioAsVoice ?? ctx.audioAsVoice,
        effectName: index === 0 ? effectName : undefined,
      });
      lastMessageId = delivery.messageId;
      parts.push({ index, kind: "media", platformMessageId: delivery.messageId });
    }
  } else {
    const delivery = await sendSpectrumOutboundPayload({
      to: ctx.to,
      text: payload.text ?? ctx.text ?? "",
      replyToId: explicitReplyToId,
      effectName,
    });
    lastMessageId = delivery.messageId;
    parts.push({ index: 0, kind: "text", platformMessageId: delivery.messageId });
  }
  return {
    receipt: {
      platformMessageIds: parts.map((part) => part.platformMessageId),
      parts,
      sentAt: Date.now(),
      ...(explicitReplyToId ? { replyToId: explicitReplyToId } : {}),
    },
    messageId: lastMessageId,
  };
}

/** Build a ContentBuilder from iMessage-specific payload fields. Returns null for plain text/media. */
function buildSpectrumPayloadContent(payload: Record<string, unknown>): ContentBuilder | null {
  if (payload.nativeContactCard === true) {
    return nativeContactCard();
  }
  if (payload.miniApp != null && typeof payload.miniApp === "object") {
    return customizedMiniApp(payload.miniApp as Parameters<typeof customizedMiniApp>[0]);
  }
  if (typeof payload.renameText === "string" && payload.renameText.trim()) {
    return rename(payload.renameText.trim());
  }
  if (typeof payload.avatarPath === "string" && payload.avatarPath.trim()) {
    return avatar(payload.avatarPath.trim());
  }
  if (typeof payload.backgroundPath === "string" && payload.backgroundPath.trim()) {
    return background(payload.backgroundPath.trim());
  }
  return null;
}

// ─── typing / reactions ───────────────────────────────────────────────

export async function sendSpectrumTypingIndicator(params: { to: string }): Promise<void> {
  const space = await resolveSpectrumSpace(params.to);
  if (!imsgPlatform) {
    return;
  }
  await sendSpectrumTyping({
    spaceId: space.id,
    ensureApp,
    getSpace: async (spaceId) => await imsgPlatform!.space.get(spaceId),
  });
}

export async function sendSpectrumReaction(params: {
  targetMessageId: string;
  spaceId: string;
  tapback: string;
}): Promise<void> {
  await ensureApp();
  if (!imsgPlatform) {
    throw new Error("Spectrum platform unavailable");
  }

  const space = await imsgPlatform.space.get(params.spaceId);
  const targetMessage = await space.getMessage(params.targetMessageId);
  if (!targetMessage) {
    throw new Error("Target message not found");
  }

  await targetMessage.react(normalizeSpectrumTapback(params.tapback));
}

export async function sendSpectrumReactionForMessage(params: {
  targetMessageId: string;
  tapback: string;
  target?: string;
  spaceId?: string;
}): Promise<void> {
  const spaceId =
    params.spaceId ??
    (params.target ? (await resolveSpectrumSpace(params.target)).id : null) ??
    resolveRememberedMessageSpace(params.targetMessageId) ??
    lastInboundSpaceId;
  if (!spaceId) {
    throw new Error("No active space for reaction; pass a chat target or send a message first");
  }
  return sendSpectrumReaction({
    targetMessageId: params.targetMessageId,
    spaceId,
    tapback: params.tapback,
  });
}

// ─── catchup ──────────────────────────────────────────────────────────

export function selectSpectrumCatchupEntries(params: {
  cursor: {
    lastProcessedMessageId?: string;
    lastProcessedMessageAt?: number;
    updatedAt: number;
  } | null;
  entries: Array<{ space: Space; message: Message }>;
}): {
  replay: Array<{ space: Space; message: Message }>;
  seed?: { messageId: string; messageAt: number };
} {
  const entries = [...params.entries].sort(
    (a, b) => (a.message.timestamp?.getTime?.() ?? 0) - (b.message.timestamp?.getTime?.() ?? 0),
  );

  if (!params.cursor) {
    const last = entries.at(-1);
    if (!last) return { replay: [] };
    return {
      replay: [],
      seed: {
        messageId: last.message.id,
        messageAt: last.message.timestamp?.getTime?.() ?? Date.now(),
      },
    };
  }

  const cursorAt = params.cursor.lastProcessedMessageAt;
  if (cursorAt != null) {
    return {
      replay: entries.filter((entry) => (entry.message.timestamp?.getTime?.() ?? 0) > cursorAt),
    };
  }

  let replayStarted = false;
  const replay: Array<{ space: Space; message: Message }> = [];
  for (const entry of entries) {
    if (!replayStarted) {
      if (entry.message.id === params.cursor.lastProcessedMessageId) {
        replayStarted = true;
      }
      continue;
    }
    replay.push(entry);
  }
  return { replay };
}

async function performSpectrumCatchup(params: {
  api: OpenClawPluginApi;
  account: ResolvedSpectrumAccount;
  client: SpectrumInstance;
}): Promise<void> {
  if (catchupInFlight) {
    return;
  }
  const catchupCfg = params.account.config.catchup;
  if (catchupCfg?.enabled === false || !imsgPlatform) {
    return;
  }
  catchupInFlight = true;
  try {
    const lookbackCount =
      typeof catchupCfg?.lookbackCount === "number" && Number.isFinite(catchupCfg.lookbackCount)
        ? Math.max(1, Math.min(100, Math.floor(catchupCfg.lookbackCount)))
        : params.account.catchupLookbackCount;
    const cursor = readCatchupCursor(params.api);
    const spaces =
      (await (
        params.client as SpectrumInstance & {
          messages?: {
            history?: (params: {
              limit: number;
            }) => Promise<Array<{ space: Space; message: Message }>>;
          };
        }
      ).messages?.history?.({ limit: lookbackCount })) ?? [];
    if (!Array.isArray(spaces) || spaces.length === 0) {
      return;
    }
    const selected = selectSpectrumCatchupEntries({ cursor, entries: spaces });
    if (selected.seed) {
      saveCatchupCursor(params.api, selected.seed.messageId, selected.seed.messageAt);
      return;
    }

    for (const entry of selected.replay) {
      const messageId = entry?.message?.id;
      if (!messageId) continue;
      await dispatchSpectrumInboundEvent({
        api: params.api,
        account: params.account,
        space: entry.space,
        message: entry.message,
        replySpace: entry.space,
        client: params.client,
        source: "catchup",
      });
    }
  } finally {
    catchupInFlight = false;
  }
}

// ─── inbound dispatch ─────────────────────────────────────────────────

async function dispatchSpectrumInboundEvent(params: {
  api: OpenClawPluginApi;
  account: ResolvedSpectrumAccount;
  space: Space;
  message: Message;
  replySpace: Space;
  client: SpectrumInstance;
  source?: "webhook" | "catchup" | "stream";
}): Promise<void> {
  const senderId = params.message.sender?.id ?? "unknown";
  const spaceId = params.space.id;
  const isGroup = (params.space as { type?: string }).type === "group";
  const peerId = isGroup ? spaceId : senderId;
  const body = extractInboundText(params.message.content);
  const media = extractSpectrumInboundMedia(params.message);

  lastInboundAt = Date.now();
  lastInboundSpaceId = spaceId;
  rememberMessageSpace(params.message.id, spaceId);
  recordInboundReaction(params.message, senderId);

  if (processedIds.has(params.message.id)) {
    params.api.logger.info?.(`[imessage-spectrum] skipping duplicate message ${params.message.id}`);
    return;
  }
  if (inFlightMessageIds.has(params.message.id)) {
    params.api.logger.info?.(
      `[imessage-spectrum] skipping in-flight duplicate message ${params.message.id}`,
    );
    return;
  }
  inFlightMessageIds.add(params.message.id);
  try {
    if (!body.trim() && media.length === 0) {
      params.api.logger.info?.(
        `[imessage-spectrum] skipping empty inbound message ${params.message.id} (${params.message.content.type})`,
      );
      processedIds.add(params.message.id);
      setTimeout(() => processedIds.delete(params.message.id), 60000);
      saveCatchupCursorForMessage(params.api, params.message);
      return;
    }

    params.api.logger.info?.(
      `[imessage-spectrum] ${params.source ?? "webhook"} message from ${senderId} in ${spaceId}: ${body.slice(0, 80)}`,
    );

    const currentCfg = readCurrentOpenClawConfig(params.api);
    const route = params.api.runtime.channel.routing.resolveAgentRoute({
      cfg: currentCfg,
      channel: CHANNEL,
      accountId: params.account.accountId,
      peer: { kind: isGroup ? "group" : "direct", id: peerId },
    });
    const sessionKey = buildSpectrumInboundSessionKey({
      agentId: route.agentId,
      accountId: params.account.accountId,
      peerId,
      isGroup,
      identityLinks: currentCfg.session?.identityLinks,
    });
    const from = resolveSpectrumFrom({ senderId, spaceId, isGroup });
    const to = resolveSpectrumTo({ senderId, spaceId, isGroup });
    const timestamp = params.message.timestamp?.getTime?.() ?? Date.now();
    const sessionContext = params.account.sessionContext?.trim() || DEFAULT_SESSION_CONTEXT;
    const inboundMediaPayload = buildSpectrumInboundMediaPayload(media);
    const inboundThreadReplyToId = resolveSpectrumInboundThreadReplyToId(params.message);

    await params.api.runtime.channel.inbound.run({
      channel: CHANNEL,
      accountId: params.account.accountId,
      raw: params.message,
      adapter: {
        ingest: () => ({
          id: params.message.id,
          timestamp,
          rawText: body,
          textForAgent:
            !params.account.enableSessionContext || bootContextInjected.has(spaceId)
              ? body
              : (bootContextInjected.add(spaceId), `${sessionContext}\n\n${body}`),
          textForCommands: body,
          raw: params.message,
        }),
        resolveTurn: () => {
          const msgCtx = params.api.runtime.channel.inbound.buildContext({
            channel: CHANNEL,
            accountId: params.account.accountId,
            timestamp,
            from,
            sender: { id: senderId },
            conversation: {
              kind: isGroup ? "group" : "direct",
              id: spaceId,
              label: senderId,
            },
            route: {
              agentId: route.agentId,
              accountId: route.accountId,
              routeSessionKey: sessionKey,
              dispatchSessionKey: sessionKey,
            },
            reply: {
              to,
              originatingTo: to,
              ...(inboundThreadReplyToId ? { replyToId: inboundThreadReplyToId } : {}),
            },
            message: {
              rawBody: body,
              commandBody: body,
              bodyForAgent: body,
            },
            extra: {
              ChatType: isGroup ? "group" : "direct",
              ...inboundMediaPayload,
              MessageId: params.message.id,
              ...(inboundThreadReplyToId ? { ReplyToId: inboundThreadReplyToId } : {}),
            },
          });
          const storePath = params.api.runtime.channel.session.resolveStorePath(
            currentCfg.session?.store,
            { agentId: route.agentId },
          );
          return {
            cfg: currentCfg,
            channel: CHANNEL,
            accountId: params.account.accountId,
            agentId: route.agentId,
            routeSessionKey: sessionKey,
            storePath,
            ctxPayload: msgCtx,
            recordInboundSession: params.api.runtime.channel.session.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher:
              params.api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
            delivery: {
              durable: () => ({
                to,
              }),
              deliver: async (payload) => {
                const replyText = payload?.text ?? "";
                const replyMediaUrl = payload?.mediaUrls?.[0] ?? payload?.mediaUrl ?? undefined;
                // Lightweight iMessage feature extraction — no structural change
                // to the original deliver flow. No-op for normal messages.
                const rawPayload = payload as Record<string, unknown> | null | undefined;
                const contentOverride = buildSpectrumPayloadContent(rawPayload ?? {});
                const payloadEffectName = resolveSpectrumPayloadEffectName(rawPayload);
                const replyToId = resolveSpectrumDeliveryReplyToId({
                  payload: rawPayload as { replyToId?: unknown } | null | undefined,
                  inboundThreadReplyToId,
                });

                if (!replyText && !replyMediaUrl && !contentOverride) {
                  return { visibleReplySent: false };
                }
                for (let attempt = 1; attempt <= 2; attempt += 1) {
                  try {
                    if (attempt === 1) {
                      await sendContentToSpace({
                        spaceId: params.replySpace.id,
                        text: replyText,
                        mediaUrl: replyMediaUrl,
                        replyToId,
                        audioAsVoice: payload?.audioAsVoice,
                        contentBuilder: contentOverride ?? undefined,
                        effectName: payloadEffectName,
                      });
                    } else {
                      await sendContentToSpace({
                        spaceId: params.replySpace.id,
                        text: replyText,
                        mediaUrl: replyMediaUrl,
                        replyToId,
                        audioAsVoice: payload?.audioAsVoice,
                        contentBuilder: contentOverride ?? undefined,
                        effectName: payloadEffectName,
                        forceFresh: true,
                      });
                    }
                    return { visibleReplySent: true };
                  } catch (deliverError) {
                    lastDeliveryError = String(deliverError);
                    params.api.logger.error?.(
                      `[imessage-spectrum] deliver attempt ${attempt}/2 failed: ${String(deliverError)}`,
                    );
                    if (attempt === 2) {
                      enqueueOutbound({
                        api: params.api,
                        account: params.account,
                        spaceId: params.replySpace.id,
                        text: replyText,
                        mediaUrl: replyMediaUrl,
                        replyToId,
                        audioAsVoice: payload?.audioAsVoice,
                        error: deliverError,
                      });
                    }
                  }
                }
                return { visibleReplySent: false };
              },
            },
            dispatcherOptions: {
              onReplyStart: async () => {
                params.api.logger.info?.(`[imessage-spectrum] agent reply started for ${senderId}`);
                if (!imsgPlatform) {
                  return;
                }
                await sendSpectrumTyping({
                  spaceId: params.replySpace.id,
                  ensureApp,
                  getSpace: async (targetSpaceId) => await imsgPlatform!.space.get(targetSpaceId),
                }).catch((err) => {
                  params.api.logger.warn?.(
                    `[imessage-spectrum] typing indicator failed: ${String(err)}`,
                  );
                });
              },
            },
            record: {
              onRecordError: (err) => {
                params.api.logger.warn?.(
                  `[imessage-spectrum] session metadata update failed for ${senderId}: ${String(err)}`,
                );
              },
            },
          };
        },
      },
    });

    processedIds.add(params.message.id);
    setTimeout(() => processedIds.delete(params.message.id), 60000);
    saveCatchupCursorForMessage(params.api, params.message);
  } finally {
    inFlightMessageIds.delete(params.message.id);
  }
}

// ─── health / webhook handlers ────────────────────────────────────────

// ─── runtime init / health / webhook handlers ───────────────────────────────────

export async function initializeSpectrumRuntime(api: OpenClawPluginApi): Promise<void> {
  runtimeApi = api;
  if (streamStatus === "stopped") {
    streamStatus = "idle";
  }
  const account = resolveCurrentSpectrumAccount(api);
  if (!account.enabled) {
    await disposeSpectrumApp();
    lastStreamError = "iMessage Spectrum account is disabled";
    streamStatus = "stopped";
    return;
  }
  if (!account.configured) {
    await disposeSpectrumApp();
    lastStreamError = "iMessage Spectrum projectId/projectSecret are not configured";
    return;
  }
  await ensureAppDeduped().catch((err) => {
    lastStreamError = String(err);
    console.warn("[imessage-spectrum] startup initialization failed:", err);
  });
  ensureSpectrumMessageStream(api);
  ensurePeriodicCatchup(api);
}

export function createSpectrumHealthHandler(api: OpenClawPluginApi) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const account = resolveCurrentSpectrumAccount(api);
    const webhookBase = resolveWebhookBase(api);
    const catchupCursor = readCatchupCursor(api);

    try {
      await initializeSpectrumRuntime(api);
    } catch (err) {
      lastDeliveryError = String(err);
      api.logger.warn?.(`[imessage-spectrum] health initialization failed: ${String(err)}`);
    }

    const connected = Boolean(app && imsgPlatform);
    const body = {
      ok: account.enabled && account.configured && account.webhookConfigured && connected,
      channel: CHANNEL,
      accountId: account.accountId,
      configured: account.configured,
      webhookConfigured: account.webhookConfigured,
      webhookUrl: webhookBase ? `${webhookBase}/channels/imessage-spectrum/webhook` : null,
      tunnelUrl,
      connected,
      stream: {
        status: streamStatus,
        restartAttempts: streamRestartAttempts,
        lastError: lastStreamError,
      },
      catchup: {
        enabled: account.config.catchup?.enabled !== false,
        intervalMs: account.catchupIntervalMs,
        inFlight: catchupInFlight,
      },
      queue: {
        pending: outboundQueue.length,
        oldestCreatedAt: outboundQueue[0]?.createdAt ?? null,
      },
      catchupCursor,
      lastInboundAt,
      lastInboundSpaceId,
      lastInboundReaction,
      lastOutboundAt,
      lastOutboundSpaceId,
      lastDeliveryError,
    };
    res.statusCode = body.ok ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body, null, 2));
    return true;
  };
}

export function createSpectrumWebhookHandler(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
      }

      const webRequest = new Request(url, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
      });

      const account = resolveCurrentSpectrumAccount(api);
      if (!account.enabled || !account.configured) {
        api.logger.error?.(
          "[imessage-spectrum] webhook received but account is disabled or incomplete",
        );
        res.statusCode = 503;
        res.end("iMessage Spectrum account not ready");
        return true;
      }
      if (!account.webhookConfigured) {
        api.logger.error?.(
          "[imessage-spectrum] webhook received but channels.imessage-spectrum.webhookSecret is not configured",
        );
        res.statusCode = 500;
        res.end("webhook secret not configured");
        return true;
      }

      const client = await ensureAppDeduped();
      await performSpectrumCatchup({ api, account, client }).catch((err) => {
        api.logger.warn?.(`[imessage-spectrum] startup catchup failed: ${String(err)}`);
      });

      const response = await client.webhook(webRequest, async (space: Space, message: Message) => {
        if (!space?.id) {
          api.logger.warn?.("[imessage-spectrum] webhook missing space ID");
          return;
        }
        await dispatchSpectrumInboundEvent({
          api,
          account,
          space,
          message,
          replySpace: space,
          client,
          source: "webhook",
        });
      });

      res.statusCode = response?.status ?? 200;
      if (response?.headers) {
        response.headers.forEach((value: string, key: string) => res.setHeader(key, value));
      }
      const responseBody = response ? await response.text().catch(() => "") : "ok";
      res.end(responseBody);
    } catch (err) {
      api.logger.error?.("[imessage-spectrum] webhook error: " + String(err));
      res.statusCode = 500;
      res.end("Internal error");
    }
    return true;
  };
}
