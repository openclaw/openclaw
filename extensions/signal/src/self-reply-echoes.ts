import crypto from "node:crypto";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { normalizeSignalUuidForCompare } from "./normalize.js";

// Echo markers intentionally stay process-local. They protect normal send/sync races without
// adding durable replay state for rare in-flight messages during OpenClaw restarts.
const MAX_ECHO_IDS = 256;
const ECHO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEXT_ECHO_TTL_MS = 2 * 60 * 1000;
const TEXT_ECHO_TIMESTAMP_SKEW_MS = 1_000;
const MEDIA_ECHO_TIMESTAMP_SKEW_MS = 10_000;

const memoryEchoes = new Map<string, Map<string, number>>();

function normalizeEchoId(value?: string | number | null): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? String(value) : undefined;
  }
  const trimmed = value?.trim();
  return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}

function normalizeEchoText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveEchoAccountKey(accountId: string, accountIdentity?: string | null): string {
  const trimmed = accountIdentity?.trim();
  const identity = normalizeSignalUuidForCompare(trimmed) ?? trimmed?.toLowerCase();
  return identity ? `${accountId}\0${identity}` : accountId;
}

function textEchoId(text: string): string {
  const prefix = text.startsWith("<media:") ? "media-text" : "text";
  return `${prefix}:${crypto.createHash("sha256").update(text).digest("base64url").slice(0, 32)}`;
}

function isTextEchoId(id: string): boolean {
  return id.startsWith("text:") || id.startsWith("media-text:");
}

export function resolveSignalSelfReplyMediaEchoText(params: {
  contentType?: string | null;
  size?: number | null;
}): string | undefined {
  if (typeof params.size !== "number" || !Number.isFinite(params.size) || params.size <= 0) {
    return undefined;
  }
  const normalizedContentType = params.contentType?.trim().toLowerCase();
  if (!normalizedContentType) {
    return undefined;
  }
  const kind = kindFromMime(normalizedContentType) ?? "attachment";
  return `<media:${kind}:${normalizedContentType}:${params.size}>`;
}

export function resolveSignalSelfReplyReactionEchoText(params: {
  emoji?: string | null;
  remove?: boolean | null;
  targetTimestamp?: number | null;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  groupId?: string | null;
}): string | undefined {
  const emoji = params.emoji?.trim();
  if (
    !emoji ||
    typeof params.targetTimestamp !== "number" ||
    !Number.isFinite(params.targetTimestamp)
  ) {
    return undefined;
  }
  const targetAuthor = params.targetAuthorUuid?.trim() ?? params.targetAuthor?.trim() ?? "";
  return `${[
    "<reaction",
    params.remove ? "remove" : "add",
    params.targetTimestamp,
    emoji,
    normalizeSignalUuidForCompare(targetAuthor) ?? targetAuthor.toLowerCase(),
    params.groupId?.trim() ?? "",
  ].join(":")}>`;
}

function echoTtlMs(id: string): number {
  return isTextEchoId(id) ? TEXT_ECHO_TTL_MS : ECHO_TTL_MS;
}

function isEchoIdMatch(params: {
  id: string;
  createdAt: number;
  timestamp?: number;
  now: number;
}): boolean {
  if (params.now - params.createdAt > echoTtlMs(params.id)) {
    return false;
  }
  if (!isTextEchoId(params.id) || params.timestamp == null) {
    return true;
  }
  const skewMs = params.id.startsWith("media-text:")
    ? MEDIA_ECHO_TIMESTAMP_SKEW_MS
    : TEXT_ECHO_TIMESTAMP_SKEW_MS;
  return Math.abs(params.timestamp - params.createdAt) <= skewMs;
}

function resolveEchoIds(params: {
  messageId?: string;
  timestamp?: number;
  text?: string | null;
  includeTextWithPrimary?: boolean;
}): string[] {
  const ids = new Set<string>();
  const primary = normalizeEchoId(params.messageId) ?? normalizeEchoId(params.timestamp);
  if (primary) {
    ids.add(primary);
  }
  const text = normalizeEchoText(params.text);
  if (text && (!primary || params.includeTextWithPrimary)) {
    ids.add(textEchoId(text));
  }
  return [...ids];
}

function rememberInMemory(accountId: string, id: string, createdAt: number): void {
  const accountEchoes = memoryEchoes.get(accountId) ?? new Map<string, number>();
  accountEchoes.set(id, createdAt);
  while (accountEchoes.size > MAX_ECHO_IDS) {
    const oldest = accountEchoes.keys().next();
    if (oldest.done) {
      break;
    }
    accountEchoes.delete(oldest.value);
  }
  memoryEchoes.set(accountId, accountEchoes);
}

export async function rememberSignalSelfReplyEcho(params: {
  accountId: string;
  accountIdentity?: string | null;
  messageId?: string;
  timestamp?: number;
  text?: string | null;
  includeTextWithPrimary?: boolean;
}): Promise<void> {
  const ids = resolveEchoIds(params);
  if (ids.length === 0) {
    return;
  }
  const createdAt = Date.now();
  const accountKey = resolveEchoAccountKey(params.accountId, params.accountIdentity);
  for (const id of ids) {
    rememberInMemory(accountKey, id, createdAt);
  }
}

export function forgetSignalSelfReplyEcho(params: {
  accountId: string;
  accountIdentity?: string | null;
  messageId?: string;
  timestamp?: number;
  text?: string | null;
}): void {
  const ids = resolveEchoIds(params);
  if (ids.length === 0) {
    return;
  }
  const accountKey = resolveEchoAccountKey(params.accountId, params.accountIdentity);
  const accountEchoes = memoryEchoes.get(accountKey);
  for (const id of ids) {
    accountEchoes?.delete(id);
  }
}

export async function hasSignalSelfReplyEcho(params: {
  accountId: string;
  accountIdentity?: string | null;
  messageId?: string;
  timestamp?: number;
  text?: string | null;
  includeTextWithPrimary?: boolean;
}): Promise<boolean> {
  const ids = resolveEchoIds(params);
  if (ids.length === 0) {
    return false;
  }
  const now = Date.now();
  const accountKey = resolveEchoAccountKey(params.accountId, params.accountIdentity);
  const accountEchoes = memoryEchoes.get(accountKey);
  for (const id of ids) {
    const memoryCreatedAt = accountEchoes?.get(id);
    if (
      memoryCreatedAt != null &&
      isEchoIdMatch({ id, createdAt: memoryCreatedAt, timestamp: params.timestamp, now })
    ) {
      return true;
    }
  }
  return false;
}
