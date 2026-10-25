import fs from "node:fs/promises";
import path from "node:path";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
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

type EnvelopeConfig = { agents?: { defaults?: { userTimezone?: string } } };

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

// Match the current facade: session/group policy and dispatch moved to their SDK owners.
vi.mock("./auto-reply/config.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auto-reply/config.runtime.js")>()),
  getRuntimeConfig: loadConfigMock,
  updateLastRoute: updateLastRouteMock,
  resolveStorePath: resolveStorePathFallback,
  resolveChannelContextVisibilityMode: resolveChannelContextVisibilityModeMock,
}));

vi.mock("./inbound/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound/runtime-api.js")>()),
  DisconnectReason: { loggedOut: 401 },
  isJidGroup: (jid: string) => typeof jid === "string" && jid.endsWith("@g.us"),
  normalizeMessageContent: (message: unknown) => message,
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("img")),
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
  getAgentScopedMediaLocalRoots: () => [] as string[],
  isControlCommandMessage: () => false,
  jidToE164: normalizePhoneLikeToE164,
  logVerbose: (_msg: string) => undefined,
  normalizeE164: normalizePhoneLikeToE164,
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
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
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
}));

vi.mock("./auto-reply/monitor/group-activation.runtime.js", () => ({
  normalizeGroupActivation: (value: unknown) =>
    value === "always" || value === "mention" ? value : undefined,
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
