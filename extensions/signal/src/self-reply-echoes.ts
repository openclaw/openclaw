import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk/file-lock";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeSignalUuidForCompare } from "./normalize.js";

// Timestamp ids are persisted to avoid replaying already-processed Note to Self prompts
// across restarts. Text/media hash fallbacks and pre-send markers stay short-lived so
// retries and repeated self messages are not suppressed beyond the echo race window.
const MAX_ECHO_IDS = 256;
const ECHO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEXT_ECHO_TTL_MS = 2 * 60 * 1000;
const TEXT_ECHO_TIMESTAMP_SKEW_MS = 1_000;
const MEDIA_ECHO_TIMESTAMP_SKEW_MS = 10_000;
const ECHO_STORE_LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 8, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true },
  stale: 30_000,
};

type EchoEntry = {
  accountId: string;
  id: string;
  createdAt: number;
};

type EchoStore = {
  entries?: EchoEntry[];
};

const memoryEchoes = new Map<string, Map<string, number>>();
let echoWriteQueue: Promise<void> = Promise.resolve();

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

function persistableEchoIds(ids: string[], includeText: boolean): string[] {
  return includeText ? ids : ids.filter((id) => !isTextEchoId(id));
}

function resolveEchoStorePath(): string {
  return path.join(resolveStateDir(), "signal", "self-reply-echoes.json");
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

async function readEchoEntries(): Promise<EchoEntry[]> {
  try {
    const raw = await fs.readFile(resolveEchoStorePath(), "utf8");
    const parsed = JSON.parse(raw) as EchoStore;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function writeEchoEntries(entries: EchoEntry[]): Promise<void> {
  const storePath = resolveEchoStorePath();
  const storeDir = path.dirname(storePath);
  const tempPath = path.join(
    storeDir,
    `.self-reply-echoes.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.chmod(storeDir, 0o700).catch(() => {});
  await fs.writeFile(tempPath, JSON.stringify({ entries }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(tempPath, 0o600).catch(() => {});
  await fs.rename(tempPath, storePath).catch(async (err: unknown) => {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  });
  await fs.chmod(storePath, 0o600).catch(() => {});
}

async function withEchoStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  return await withFileLock(resolveEchoStorePath(), ECHO_STORE_LOCK_OPTIONS, fn);
}

function pruneEchoEntries(entries: EchoEntry[], now: number): EchoEntry[] {
  const latestByAccount = new Map<string, Map<string, EchoEntry>>();
  for (const entry of entries) {
    if (!entry.accountId || !entry.id || !Number.isFinite(entry.createdAt)) {
      continue;
    }
    if (now - entry.createdAt > echoTtlMs(entry.id)) {
      continue;
    }
    const accountEntries = latestByAccount.get(entry.accountId) ?? new Map<string, EchoEntry>();
    const existing = accountEntries.get(entry.id);
    if (!existing || entry.createdAt > existing.createdAt) {
      accountEntries.set(entry.id, entry);
    }
    latestByAccount.set(entry.accountId, accountEntries);
  }
  return [...latestByAccount.values()].flatMap((accountEntries) =>
    [...accountEntries.values()]
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ECHO_IDS),
  );
}

export async function rememberSignalSelfReplyEcho(params: {
  accountId: string;
  accountIdentity?: string | null;
  messageId?: string;
  timestamp?: number;
  text?: string | null;
  includeTextWithPrimary?: boolean;
  persist?: boolean;
  persistText?: boolean;
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
  if (params.persist === false) {
    return;
  }
  const persistentIds = persistableEchoIds(ids, params.persistText === true);
  if (persistentIds.length === 0) {
    return;
  }
  try {
    const write = echoWriteQueue.then(async () => {
      await withEchoStoreLock(async () => {
        const entries = pruneEchoEntries(await readEchoEntries(), createdAt);
        await writeEchoEntries([
          ...persistentIds.map((id) => ({ accountId: accountKey, id, createdAt })),
          ...entries,
        ]);
      });
    });
    echoWriteQueue = write.catch(() => {});
    await write;
  } catch {
    // Echo tracking is a loop-prevention aid; send delivery must not fail if the store is unavailable.
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
  const entries = pruneEchoEntries(await readEchoEntries(), now);
  const match = entries.find(
    (entry) =>
      entry.accountId === accountKey &&
      ids.includes(entry.id) &&
      isEchoIdMatch({ id: entry.id, createdAt: entry.createdAt, timestamp: params.timestamp, now }),
  );
  if (match) {
    rememberInMemory(accountKey, match.id, match.createdAt);
    return true;
  }
  return false;
}
