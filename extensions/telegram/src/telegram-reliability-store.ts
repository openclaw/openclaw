import path from "node:path";
import { loadJsonFile, saveJsonFile } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { TelegramReliabilityErrorKind, TelegramTokenRisk } from "./telegram-reliability.js";

const STORE_VERSION = 1;
const MAX_RECORDS = 500;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

export type TelegramInflightState = "dispatched" | "completed" | "failed" | "interrupted";

export type TelegramInflightRecord = {
  id: string;
  accountId: string;
  chatId: string;
  messageId?: string;
  thread?: { id?: string | number | null; scope?: string };
  sessionKey?: string;
  agentId?: string;
  state: TelegramInflightState;
  receivedAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  failedAt?: string;
  interruptedAt?: string;
  updatedAt: string;
  promptPreview?: string;
  promptHash?: string;
  tokenTotal?: number;
  tokenRisk?: TelegramTokenRisk;
  errorKind?: TelegramReliabilityErrorKind;
  errorText?: string;
};

type TelegramInflightStore = {
  version: number;
  records: Record<string, TelegramInflightRecord>;
};

export type MarkTelegramInflightDispatchedParams = {
  accountId?: string;
  chatId: string | number;
  messageId?: string | number;
  thread?: { id?: string | number | null; scope?: string };
  sessionKey?: string;
  agentId?: string;
  receivedAt?: Date;
  promptText?: string;
  tokenTotal?: number;
  tokenRisk?: TelegramTokenRisk;
};

export function resolveTelegramInflightId(params: {
  accountId?: string;
  chatId: string | number;
  messageId?: string | number;
  thread?: { id?: string | number | null; scope?: string };
}): string {
  return [
    normalizeAccountId(params.accountId),
    String(params.chatId),
    params.thread?.scope ?? "chat",
    params.thread?.id ?? "root",
    params.messageId ?? "unknown",
  ]
    .map((part) => String(part).replace(/[^a-z0-9._:-]+/gi, "_"))
    .join(":");
}

export function markTelegramInflightDispatched(
  params: MarkTelegramInflightDispatchedParams,
): string {
  const accountId = normalizeAccountId(params.accountId);
  const id = resolveTelegramInflightId({ ...params, accountId });
  const store = loadStore(accountId);
  const now = new Date();
  const receivedAt = params.receivedAt ?? now;
  const existing = store.records[id];
  store.records[id] = {
    ...existing,
    id,
    accountId,
    chatId: String(params.chatId),
    messageId: params.messageId == null ? undefined : String(params.messageId),
    thread: params.thread,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    state: "dispatched",
    receivedAt: existing?.receivedAt ?? receivedAt.toISOString(),
    dispatchedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    promptPreview: clipPromptPreview(params.promptText),
    promptHash: hashText(params.promptText),
    tokenTotal: params.tokenTotal,
    tokenRisk: params.tokenRisk,
    errorKind: undefined,
    errorText: undefined,
  };
  saveStore(accountId, pruneStore(store));
  return id;
}

export function markTelegramInflightCompleted(params: {
  accountId?: string;
  id: string;
}): void {
  updateTerminal(params.accountId, params.id, "completed");
}

export function markTelegramInflightFailed(params: {
  accountId?: string;
  id: string;
  errorKind: TelegramReliabilityErrorKind;
  errorText?: string;
}): void {
  const accountId = normalizeAccountId(params.accountId);
  const store = loadStore(accountId);
  const record = store.records[params.id];
  if (!record) {
    return;
  }
  const now = new Date().toISOString();
  store.records[params.id] = {
    ...record,
    state: "failed",
    failedAt: now,
    updatedAt: now,
    errorKind: params.errorKind,
    errorText: clipErrorText(params.errorText),
  };
  saveStore(accountId, pruneStore(store));
}

export function markStaleTelegramInflightInterrupted(params: {
  accountId?: string;
  olderThanMs?: number;
  recentWindowMs?: number;
  now?: Date;
}): TelegramInflightRecord[] {
  const accountId = normalizeAccountId(params.accountId);
  const store = loadStore(accountId);
  const now = params.now ?? new Date();
  const olderThanMs = params.olderThanMs ?? 60_000;
  const recentWindowMs = params.recentWindowMs ?? 6 * 60 * 60 * 1000;
  const interrupted: TelegramInflightRecord[] = [];
  for (const [id, record] of Object.entries(store.records)) {
    if (record.state !== "dispatched") {
      continue;
    }
    const updatedAt = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      continue;
    }
    const age = now.getTime() - updatedAt;
    if (age < olderThanMs || age > recentWindowMs) {
      continue;
    }
    const interruptedAt = now.toISOString();
    const next = {
      ...record,
      state: "interrupted" as const,
      interruptedAt,
      updatedAt: interruptedAt,
      errorKind: "unknown" as TelegramReliabilityErrorKind,
      errorText: "Gateway restarted or Telegram runtime was interrupted before completion.",
    };
    store.records[id] = next;
    interrupted.push(next);
  }
  if (interrupted.length > 0) {
    saveStore(accountId, pruneStore(store));
  }
  return interrupted;
}

function updateTerminal(
  accountIdInput: string | undefined,
  id: string,
  state: Extract<TelegramInflightState, "completed" | "failed" | "interrupted">,
): void {
  const accountId = normalizeAccountId(accountIdInput);
  const store = loadStore(accountId);
  const record = store.records[id];
  if (!record) {
    return;
  }
  const now = new Date().toISOString();
  store.records[id] = {
    ...record,
    state,
    completedAt: state === "completed" ? now : record.completedAt,
    failedAt: state === "failed" ? now : record.failedAt,
    interruptedAt: state === "interrupted" ? now : record.interruptedAt,
    updatedAt: now,
  };
  saveStore(accountId, pruneStore(store));
}

function loadStore(accountId: string): TelegramInflightStore {
  const loaded = loadJsonFile(storePath(accountId));
  if (!loaded || typeof loaded !== "object") {
    return emptyStore();
  }
  const store = loaded as Partial<TelegramInflightStore>;
  if (store.version !== STORE_VERSION || !store.records || typeof store.records !== "object") {
    return emptyStore();
  }
  return { version: STORE_VERSION, records: store.records };
}

function saveStore(accountId: string, store: TelegramInflightStore): void {
  saveJsonFile(storePath(accountId), store);
}

function pruneStore(store: TelegramInflightStore): TelegramInflightStore {
  const now = Date.now();
  const entries = Object.entries(store.records)
    .filter(([, record]) => {
      if (record.state === "dispatched") {
        return true;
      }
      const updatedAt = Date.parse(record.updatedAt);
      return Number.isFinite(updatedAt) && now - updatedAt <= TERMINAL_TTL_MS;
    })
    .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))
    .slice(0, MAX_RECORDS);
  return { version: STORE_VERSION, records: Object.fromEntries(entries) };
}

function emptyStore(): TelegramInflightStore {
  return { version: STORE_VERSION, records: {} };
}

function storePath(accountId: string): string {
  return path.join(resolveStateDir(), "telegram", `reliability-inflight-${accountId}.json`);
}

function normalizeAccountId(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function clipPromptPreview(text?: string): string | undefined {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function clipErrorText(text?: string): string | undefined {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function hashText(text?: string): string | undefined {
  if (!text) {
    return undefined;
  }
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
