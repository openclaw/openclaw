// Whatsapp plugin module implements temporary group listen windows.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppAccount } from "../../accounts.js";
import { resolveWhatsAppGroupConversationId } from "../../inbound/group-conversation.js";

type ListenWindowConfig = {
  durationMs: number;
  maxMs: number;
};

type ListenWindowState = {
  startedAtMs: number;
  untilMs: number;
};

const listenWindows = new Map<string, ListenWindowState>();

function normalizeMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function resolveGroupListenWindowKey(params: {
  agentId: string;
  accountId?: string | null;
  sessionKey: string;
  conversationId: string;
}) {
  return [
    params.agentId,
    params.accountId?.trim() || "default",
    params.sessionKey,
    resolveWhatsAppGroupConversationId(params.conversationId),
  ].join("\u0000");
}

export function resolveGroupListenWindowConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  conversationId: string;
}): ListenWindowConfig | undefined {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const conversationId = resolveWhatsAppGroupConversationId(params.conversationId);
  const group = account.groups?.[conversationId] ?? account.groups?.[params.conversationId];
  const wildcardGroup = account.groups?.["*"];
  const durationMs = normalizeMilliseconds(
    group?.listenAfterMentionMs ?? wildcardGroup?.listenAfterMentionMs,
  );
  if (durationMs === undefined || durationMs <= 0) {
    return undefined;
  }
  const configuredMaxMs = normalizeMilliseconds(
    group?.listenAfterMentionMaxMs ?? wildcardGroup?.listenAfterMentionMaxMs,
  );
  return {
    durationMs,
    maxMs:
      configuredMaxMs && configuredMaxMs > 0 ? Math.max(durationMs, configuredMaxMs) : durationMs,
  };
}

export function resolveGroupListenWindowState(params: {
  agentId: string;
  accountId?: string | null;
  sessionKey: string;
  conversationId: string;
  nowMs?: number;
}): ListenWindowState | undefined {
  const key = resolveGroupListenWindowKey(params);
  const state = listenWindows.get(key);
  if (!state) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  if (state.untilMs <= nowMs) {
    listenWindows.delete(key);
    return undefined;
  }
  return state;
}

export function armGroupListenWindow(params: {
  agentId: string;
  accountId?: string | null;
  sessionKey: string;
  conversationId: string;
  config: ListenWindowConfig;
  nowMs?: number;
}): ListenWindowState {
  const nowMs = params.nowMs ?? Date.now();
  const key = resolveGroupListenWindowKey(params);
  const existing = listenWindows.get(key);
  const startedAtMs = existing && existing.untilMs > nowMs ? existing.startedAtMs : nowMs;
  const untilMs = Math.min(nowMs + params.config.durationMs, startedAtMs + params.config.maxMs);
  const state = { startedAtMs, untilMs };
  listenWindows.set(key, state);
  return state;
}

export function clearGroupListenWindow(params: {
  agentId: string;
  accountId?: string | null;
  sessionKey: string;
  conversationId: string;
}) {
  listenWindows.delete(resolveGroupListenWindowKey(params));
}

export function clearGroupListenWindowsForTest() {
  listenWindows.clear();
}
