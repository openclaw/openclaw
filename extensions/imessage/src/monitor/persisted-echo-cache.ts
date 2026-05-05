import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

type PersistedEchoEntry = {
  scope: string;
  text?: string;
  messageId?: string;
  timestamp: number;
};

const PERSISTED_ECHO_TTL_MS = 2 * 60 * 1000;
const MAX_PERSISTED_ECHO_ENTRIES = 256;

function resolvePersistedEchoPath(): string {
  return path.join(resolveStateDir(), "imessage", "sent-echoes.jsonl");
}

function normalizeText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\r\n?/g, "\n").trim();
  return normalized || undefined;
}

function normalizeMessageId(messageId: string | undefined): string | undefined {
  const normalized = messageId?.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return undefined;
  }
  return normalized;
}

function parseEntry(line: string): PersistedEchoEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<PersistedEchoEntry>;
    if (typeof parsed.scope !== "string" || typeof parsed.timestamp !== "number") {
      return null;
    }
    return {
      scope: parsed.scope,
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      messageId: typeof parsed.messageId === "string" ? parsed.messageId : undefined,
      timestamp: parsed.timestamp,
    };
  } catch {
    return null;
  }
}

// In-memory mirror of the persisted file. The echo cache is consulted on
// every inbound message; without a cache, group-chat bursts trigger a
// readFileSync + JSON.parse for every member's reply. The mirror is
// invalidated by file mtime so concurrent gateway processes (rare) and
// post-restart hydrate still see fresh data.
let mirror: { entries: PersistedEchoEntry[]; mtimeMs: number } | null = null;
let persistenceFailureLogged = false;
function reportFailure(scope: string, err: unknown): void {
  if (persistenceFailureLogged) return;
  persistenceFailureLogged = true;
  logVerbose(`imessage echo-cache: ${scope} disabled after first failure: ${String(err)}`);
}

function loadMirrorIfStale(): void {
  const filePath = resolvePersistedEchoPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      reportFailure("stat", err);
    }
    mirror = { entries: [], mtimeMs: 0 };
    return;
  }
  if (mirror && mirror.mtimeMs === mtimeMs) {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    reportFailure("read", err);
    mirror = { entries: [], mtimeMs };
    return;
  }
  const cutoff = Date.now() - PERSISTED_ECHO_TTL_MS;
  const entries = raw
    .split(/\n+/)
    .map(parseEntry)
    .filter((entry): entry is PersistedEchoEntry => Boolean(entry && entry.timestamp >= cutoff))
    .slice(-MAX_PERSISTED_ECHO_ENTRIES);
  mirror = { entries, mtimeMs };
}

function readRecentEntries(): PersistedEchoEntry[] {
  loadMirrorIfStale();
  return mirror?.entries ?? [];
}

function rewriteRecentEntries(entries: PersistedEchoEntry[]): void {
  const filePath = resolvePersistedEchoPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
      "utf8",
    );
  } catch (err) {
    reportFailure("write", err);
    // Persistence failed; don't update the in-memory mirror so the next
    // read still reflects what's actually on disk.
    return;
  }
  // Update mirror to reflect what we just wrote, so the next has() call
  // doesn't re-read the file we just authored.
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // ignore — stale mirror will refresh on next access
  }
  mirror = { entries: [...entries], mtimeMs };
}

export function rememberPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  messageId?: string;
}): void {
  const entry: PersistedEchoEntry = {
    scope: params.scope,
    text: normalizeText(params.text),
    messageId: normalizeMessageId(params.messageId),
    timestamp: Date.now(),
  };
  if (!entry.text && !entry.messageId) {
    return;
  }
  const entries = [...readRecentEntries(), entry].slice(-MAX_PERSISTED_ECHO_ENTRIES);
  rewriteRecentEntries(entries);
}

export function hasPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  messageId?: string;
}): boolean {
  const text = normalizeText(params.text);
  const messageId = normalizeMessageId(params.messageId);
  if (!text && !messageId) {
    return false;
  }
  for (const entry of readRecentEntries()) {
    if (entry.scope !== params.scope) {
      continue;
    }
    if (messageId && entry.messageId === messageId) {
      return true;
    }
    if (text && entry.text === text) {
      return true;
    }
  }
  return false;
}
