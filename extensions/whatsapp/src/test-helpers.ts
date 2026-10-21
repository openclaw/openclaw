import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatEnvelopeTimestamp } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTimezone } from "openclaw/plugin-sdk/time-runtime";
import { vi } from "vitest";
import type { MockBaileysSocket } from "../../../test/mocks/baileys.js";
import { createMockBaileys } from "../../../test/mocks/baileys.js";

// Use globalThis to store the mock config so it survives vi.mock hoisting
const CONFIG_KEY = Symbol.for("openclaw:testConfigMock");
// Default open access; individual fixtures override it.
const DEFAULT_CONFIG = {
  channels: { whatsapp: { allowFrom: ["*"] } },
  messages: { messagePrefix: undefined, responsePrefix: undefined },
};

if (!(globalThis as Record<symbol, unknown>)[CONFIG_KEY]) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}
export function setLoadConfigMock(fn: unknown) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = typeof fn === "function" ? fn : () => fn;
}

export function resetLoadConfigMock() {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}

function resolveStorePathFallback(store?: string, opts?: { agentId?: string }) {
  if (!store) {
    const agentId = normalizeLowercaseStringOrEmpty(opts?.agentId?.trim() || "main");
    const root = path.join(process.env.HOME ?? "/tmp", ".openclaw", "agents");
    return path.join(root, agentId, "sessions", "sessions.json");
  }
  return path.resolve(store.replaceAll("{agentId}", opts?.agentId?.trim() || "main"));
}

function loadConfigMock() {
  const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
  return typeof getter === "function" ? getter() : DEFAULT_CONFIG;
}

async function updateLastRouteMock(params: {
  storePath: string;
  sessionKey: string;
  deliveryContext: { channel: string; to: string; accountId?: string };
}) {
  const raw = await fs.readFile(params.storePath, "utf8").catch(() => "{}");
  const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const current = store[params.sessionKey] ?? {};
  store[params.sessionKey] = {
    ...current,
    lastChannel: params.deliveryContext.channel,
    lastTo: params.deliveryContext.to,
    lastAccountId: params.deliveryContext.accountId,
  };
  await fs.writeFile(params.storePath, JSON.stringify(store));
}

function loadSessionStoreMock(storePath: string) {
  try {
    return JSON.parse(fsSync.readFileSync(storePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type ReplyPayload = Record<string, unknown>;
type BufferedDispatchReplyParams = {
  ctx: ReplyPayload;
  replyResolver: (
    ctx: ReplyPayload,
    opts?: BufferedReplyOptions,
  ) => Promise<ReplyPayload | undefined>;
  replyOptions?: BufferedReplyOptions;
  dispatcherOptions: {
    deliver: (payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
    onReplyStart?: (() => Promise<void>) | (() => void);
  };
};

type MockTypingController = {
  markDispatchIdle?: () => void;
  markRunComplete?: () => void;
};

type BufferedReplyOptions = ReplyPayload & {
  onTypingController?: (typing: MockTypingController) => void;
};

type TestEnvelopeOptions = {
  timezone?: string;
  includeTimestamp?: boolean;
  includeElapsed?: boolean;
  userTimezone?: string;
};

type TestInboundEnvelopeParams = {
  channel?: string;
  from?: string;
  body: string;
  timestamp?: number | Date;
  chatType?: string;
  senderLabel?: string;
  sender?: { name?: string; e164?: string; id?: string };
  previousTimestamp?: number | Date;
  envelope?: TestEnvelopeOptions;
  fromMe?: boolean;
};

function sanitizeEnvelopeHeaderPart(value: string) {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replace(/\s+/g, " ")
    .trim();
}

type EnvelopeConfig = { agents?: { defaults?: { userTimezone?: string } } };
function resolveEnvelopeOptionsMock(cfg?: EnvelopeConfig): TestEnvelopeOptions {
  const defaults = cfg?.agents?.defaults;
  const configuredTimezone = normalizeOptionalString(defaults?.userTimezone);
  return {
    timezone: configuredTimezone ? (resolveTimezone(configuredTimezone) ?? "local") : undefined,
    includeTimestamp: true,
    includeElapsed: true,
    userTimezone: defaults?.userTimezone,
  };
}

function resolveEnvelopeTimestampMock(
  timestamp: number | Date | undefined,
  envelope?: TestEnvelopeOptions,
) {
  if (!timestamp || envelope?.includeTimestamp === false) {
    return undefined;
  }
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const zone = envelope?.timezone?.trim();
  return formatEnvelopeTimestamp(
    date,
    (zone === "user" ? envelope?.userTimezone?.trim() : zone) || "local",
  );
}

function resolveSenderLabelMock(sender?: TestInboundEnvelopeParams["sender"]) {
  const display = sender?.name?.trim();
  const idPart = sender?.e164?.trim() || sender?.id?.trim();
  return display && idPart && display !== idPart
    ? `${display} (${idPart})`
    : display || idPart || undefined;
}

function resolveDirectEnvelopeBodyLabelMock(from?: string) {
  const label = sanitizeEnvelopeHeaderPart(from?.trim() || "");
  const idMarkerIndex = label.search(/\s+id:/i);
  const displayLabel = idMarkerIndex > 0 ? label.slice(0, idMarkerIndex).trim() : label;
  return displayLabel.includes(":") ? "(sender)" : displayLabel;
}

function formatInboundEnvelopeMock(params: TestInboundEnvelopeParams) {
  const chatType = normalizeLowercaseStringOrEmpty(params.chatType);
  const isDirect = !chatType || chatType === "direct";
  const sender = params.senderLabel?.trim() || resolveSenderLabelMock(params.sender);
  const directSender = resolveDirectEnvelopeBodyLabelMock(params.from);
  const body =
    isDirect && params.fromMe
      ? `(self): ${params.body}`
      : isDirect && directSender
        ? `${directSender}: ${params.body}`
        : !isDirect && sender
          ? `${sanitizeEnvelopeHeaderPart(sender)}: ${params.body}`
          : params.body;
  const from = params.from?.trim();
  const parts = [
    sanitizeEnvelopeHeaderPart(params.channel?.trim() || "Channel"),
    from ? sanitizeEnvelopeHeaderPart(from) : undefined,
    resolveEnvelopeTimestampMock(params.timestamp, params.envelope),
  ].filter((part) => part !== undefined);
  return `[${parts.join(" ")}] ${body}`;
}

function normalizePhoneLikeToE164(value: string) {
  const digits = value.replace(/\D+/g, "");
  return digits ? `+${digits}` : null;
}

function resolveSendableOutboundReplyPartsMock(payload: Record<string, unknown>) {
  return {
    text: typeof payload.text === "string" ? payload.text : "",
    hasMedia:
      typeof payload.mediaUrl === "string" ||
      typeof payload.mediaPath === "string" ||
      typeof payload.fileUrl === "string",
  };
}

type VisibleReplyConfig = { visibleReplies?: "automatic" | "message_tool" };
function resolveChannelMessageSourceReplyDeliveryModeMock(params: {
  cfg: {
    messages?: VisibleReplyConfig & { groupChat?: VisibleReplyConfig };
  };
  ctx: { ChatType?: string; CommandSource?: "text" | "native" };
  requested?: "automatic" | "message_tool_only";
}) {
  if (params.requested) {
    return params.requested;
  }
  if (params.ctx.CommandSource === "native") {
    return "automatic";
  }
  const chatType = normalizeLowercaseStringOrEmpty(params.ctx.ChatType);
  if (chatType === "group" || chatType === "channel") {
    return params.cfg.messages?.groupChat?.visibleReplies === "automatic"
      ? "automatic"
      : "message_tool_only";
  }
  return params.cfg.messages?.visibleReplies === "message_tool" ? "message_tool_only" : "automatic";
}

async function dispatchReplyMock(params: BufferedDispatchReplyParams) {
  let typingController: MockTypingController | undefined;
  const replyOptions: BufferedReplyOptions = {
    ...params.replyOptions,
    onTypingController: (typing) => {
      typingController = typing;
      params.replyOptions?.onTypingController?.(typing);
    },
  };
  await params.dispatcherOptions.onReplyStart?.();
  try {
    const payload = await params.replyResolver(params.ctx, replyOptions);
    const parts =
      payload && typeof payload === "object"
        ? resolveSendableOutboundReplyPartsMock(payload)
        : undefined;
    const queuedFinal = Boolean(parts && (parts.text.trim() || parts.hasMedia));
    if (queuedFinal && payload) {
      await params.dispatcherOptions.deliver(payload, { kind: "final" });
    }
    return { queuedFinal, counts: { tool: 0, block: 0, final: queuedFinal ? 1 : 0 } };
  } finally {
    typingController?.markRunComplete?.();
    typingController?.markDispatchIdle?.();
  }
}

type VisibilityConfig = { contextVisibility?: string };
type ChannelVisibilityConfig = VisibilityConfig & { accounts?: Record<string, VisibilityConfig> };
function resolveChannelContextVisibilityModeMock(params: {
  cfg: { channels?: Record<string, ChannelVisibilityConfig> };
  channel: string;
  accountId?: string | null;
  configuredContextVisibility?: string;
}) {
  if (params.configuredContextVisibility) {
    return params.configuredContextVisibility;
  }
  const channelConfig = params.cfg.channels?.[params.channel];
  const accountMode =
    (params.accountId
      ? channelConfig?.accounts?.[params.accountId]?.contextVisibility
      : undefined) ?? channelConfig?.accounts?.main?.contextVisibility;
  return accountMode ?? channelConfig?.contextVisibility ?? "all";
}

function resolveGroupSessionKeyMock(ctx: { From?: string; ChatType?: string; Provider?: string }) {
  const from = ctx.From?.trim() ?? "";
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  const normalizedFrom = normalizeLowercaseStringOrEmpty(from);
  const isGroup =
    chatType === "group" ||
    chatType === "channel" ||
    from.includes(":group:") ||
    from.endsWith("@g.us");
  if (!from || !isGroup) {
    return null;
  }
  return {
    key: `whatsapp:group:${normalizedFrom}`,
    channel: normalizeLowercaseStringOrEmpty(ctx.Provider) || "whatsapp",
    id: normalizedFrom,
    chatType: chatType === "channel" ? "channel" : "group",
  };
}

type GroupConfig = {
  groups?: Record<string, Record<string, unknown>>;
  groupPolicy?: string;
  allowFrom?: string[];
  groupAllowFrom?: string[];
};
type GroupParams = {
  cfg: { channels?: { whatsapp?: GroupConfig } };
  groupId?: string | null;
};
function resolveChannelGroupPolicyMock(params: GroupParams & { hasGroupAllowFrom?: boolean }) {
  const whatsappCfg = params.cfg.channels?.whatsapp;
  const groups = whatsappCfg?.groups;
  const groupConfig = params.groupId ? groups?.[params.groupId] : undefined;
  const defaultConfig = groups?.["*"];
  const hasGroups = Boolean(groups && Object.keys(groups).length > 0);
  const allowAll = Boolean(defaultConfig);
  const groupPolicy = whatsappCfg?.groupPolicy ?? "disabled";
  const senderFilterBypass =
    groupPolicy === "allowlist" && !hasGroups && Boolean(params.hasGroupAllowFrom);
  const allowed =
    groupPolicy === "disabled"
      ? false
      : groupPolicy !== "allowlist" || allowAll || Boolean(groupConfig) || senderFilterBypass;
  return {
    allowlistEnabled: groupPolicy === "allowlist" || hasGroups,
    allowed,
    groupConfig,
    defaultConfig,
  };
}

function resolveChannelGroupRequireMentionMock(
  params: GroupParams & { requireMentionOverride?: boolean },
) {
  const groups = params.cfg.channels?.whatsapp?.groups;
  const group = params.groupId ? groups?.[params.groupId] : undefined;
  const fallback = groups?.["*"];
  const values = [group?.requireMention, fallback?.requireMention, params.requireMentionOverride];
  return values.find((value): value is boolean => typeof value === "boolean") ?? true;
}

vi.mock("./auto-reply/config.runtime.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
  updateLastRoute: updateLastRouteMock,
  loadSessionStore: loadSessionStoreMock,
  recordSessionMetaFromInbound: async () => undefined,
  resolveStorePath: resolveStorePathFallback,
  evaluateSessionFreshness: () => ({ fresh: false }),
  resolveChannelContextVisibilityMode: resolveChannelContextVisibilityModeMock,
  resolveChannelGroupPolicy: resolveChannelGroupPolicyMock,
  resolveChannelGroupRequireMention: resolveChannelGroupRequireMentionMock,
  resolveChannelResetConfig: () => undefined,
  resolveGroupSessionKey: resolveGroupSessionKeyMock,
  resolveSessionKey: (_scope: string, msg: { From?: string }, mainKey?: string) =>
    msg.From?.trim() || mainKey || "main",
  resolveSessionResetPolicy: () => undefined,
  resolveSessionResetType: () => "message",
  resolveThreadFlag: () => false,
}));

vi.mock("./inbound/runtime-api.js", () => ({
  DisconnectReason: { loggedOut: 401 },
  isJidGroup: (jid: string) => typeof jid === "string" && jid.endsWith("@g.us"),
  normalizeMessageContent: (message: unknown) => message,
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("img")),
  saveMediaBuffer: vi.fn().mockImplementation(async (_buf: Buffer, contentType?: string) => ({
    id: "mid",
    path: "/tmp/mid",
    size: _buf.length,
    contentType,
  })),
}));

vi.mock("./auto-reply/monitor/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auto-reply/monitor/runtime-api.js")>()),
  buildHistoryContextFromEntries: (params: {
    entries: Array<{ sender?: string; body: string; timestamp?: number }>;
    currentMessage: string;
    formatEntry?: (entry: { sender?: string; body: string; timestamp?: number }) => string;
  }) => {
    const rendered = params.entries
      .map((entry) => params.formatEntry?.(entry) ?? `${entry.sender ?? "Unknown"}: ${entry.body}`)
      .join("\n");
    return rendered
      ? `Chat messages since your last reply:\n${rendered}\n\n${params.currentMessage}`
      : params.currentMessage;
  },
  createChannelMessageReplyPipeline: () => ({
    onModelSelected: undefined,
    responsePrefix: undefined,
  }),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(dispatchReplyMock),
  formatInboundEnvelope: formatInboundEnvelopeMock,
  getAgentScopedMediaLocalRoots: () => [] as string[],
  isControlCommandMessage: () => false,
  jidToE164: normalizePhoneLikeToE164,
  logVerbose: (_msg: string) => undefined,
  normalizeE164: normalizePhoneLikeToE164,
  readStoreAllowFromForDmPolicy: async () => [] as string[],
  recordSessionMetaFromInbound: async () => undefined,
  resolveChannelMessageSourceReplyDeliveryMode: resolveChannelMessageSourceReplyDeliveryModeMock,
  resolveChannelContextVisibilityMode: resolveChannelContextVisibilityModeMock,
  resolveChunkMode: () => undefined,
  resolveIdentityNamePrefix: (cfg: { messages?: { responsePrefix?: string } }, _agentId: string) =>
    cfg.messages?.responsePrefix,
  resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
  resolveInboundSessionEnvelopeContextAsync: async (params: {
    cfg: { session?: { store?: string } } & EnvelopeConfig;
    agentId: string;
  }) => ({
    storePath: resolveStorePathFallback(params.cfg.session?.store, { agentId: params.agentId }),
    envelopeOptions: resolveEnvelopeOptionsMock(params.cfg),
    previousTimestamp: undefined,
  }),
  resolveMarkdownTableMode: () => undefined,
  resolvePinnedMainDmOwnerFromAllowlist: (params: {
    allowFrom?: string[];
    normalizeEntry: (entry: string) => string | null;
  }) => {
    const first = params.allowFrom?.[0];
    return first ? params.normalizeEntry(first) : null;
  },
  resolveSendableOutboundReplyParts: resolveSendableOutboundReplyPartsMock,
  resolveTextChunkLimit: () => 64_000,
  shouldComputeCommandAuthorized: () => false,
  shouldLogVerbose: () => false,
  toLocationContext: (location: unknown) => ({ Location: location }),
}));

vi.mock("./auto-reply/monitor/group-activation.runtime.js", () => ({
  normalizeGroupActivation: (value: unknown) =>
    value === "always" || value === "mention" ? value : undefined,
}));

vi.mock("./auto-reply/monitor/message-line.runtime.js", () => ({
  formatInboundEnvelope: formatInboundEnvelopeMock,
}));

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: () => "/tmp/openclaw-oauth",
}));

// mock-isolation: synthetic Baileys sockets keep tests off real WhatsApp sessions and credentials.
vi.mock("./session.runtime.js", () => {
  const created = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    created.lastSocket;
  return { ...created.mod };
});

vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: vi.fn(async () => "ASCII-QR"),
}));

export const baileys = await import("./session.runtime.js");

function resetMockExport<T extends (...args: never[]) => unknown>(current: T, implementation: T) {
  if (!("mockReset" in current) || typeof current.mockReset !== "function") {
    return;
  }
  current.mockReset();
  if ("mockImplementation" in current && typeof current.mockImplementation === "function") {
    current.mockImplementation(implementation);
  }
}

export function resetBaileysMocks() {
  const recreated = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    recreated.lastSocket;

  resetMockExport(baileys.makeWASocket, recreated.mod.makeWASocket);
  resetMockExport(baileys.useMultiFileAuthState, recreated.mod.useMultiFileAuthState);
  resetMockExport(baileys.fetchLatestBaileysVersion, recreated.mod.fetchLatestBaileysVersion);
  resetMockExport(baileys.makeCacheableSignalKeyStore, recreated.mod.makeCacheableSignalKeyStore);
}

export function getLastSocket(): MockBaileysSocket {
  const getter = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")];
  if (typeof getter === "function") {
    return (getter as () => MockBaileysSocket)();
  }
  throw new Error(getter ? "Invalid Baileys socket getter" : "Baileys mock not initialized");
}
