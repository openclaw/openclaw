import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

type PersistedEchoEntry = {
  scope: string;
  text?: string;
  messageId?: string;
  timestamp: number;
};

// 12h covers the maximum `channels.imessage.catchup.maxAgeMinutes` clamp (720
// minutes). Without this, the live path's previous 2-minute window was
// shorter than any realistic catchup window — own outbound rows from before
// a gateway gap would fall out of the dedupe set before catchup could replay
// the inbound rows around them, and the agent's own messages would land back
// in the inbound pipeline as if they were external sends.
const PERSISTED_ECHO_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PERSISTED_ECHO_ENTRIES = 256;

const PERSISTED_ECHO_STORE = createPluginStateSyncKeyedStore<PersistedEchoEntry>("imessage", {
  namespace: "sent-echoes",
  maxEntries: MAX_PERSISTED_ECHO_ENTRIES,
  defaultTtlMs: PERSISTED_ECHO_TTL_MS,
});

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

function persistedEchoEntryKey(entry: PersistedEchoEntry): string {
  return createHash("sha256")
    .update(`${entry.scope}\0${entry.text ?? ""}\0${entry.messageId ?? ""}\0${entry.timestamp}`)
    .digest("hex")
    .slice(0, 40);
}

function toPersistedEchoEntry(entry: PersistedEchoEntry): PersistedEchoEntry {
  return {
    scope: entry.scope,
    timestamp: entry.timestamp,
    ...(typeof entry.text === "string" ? { text: entry.text } : {}),
    ...(typeof entry.messageId === "string" ? { messageId: entry.messageId } : {}),
  };
}

function isPersistedEchoEntry(value: unknown): value is PersistedEchoEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<PersistedEchoEntry>;
  return (
    typeof entry.scope === "string" &&
    typeof entry.timestamp === "number" &&
    (entry.text === undefined || typeof entry.text === "string") &&
    (entry.messageId === undefined || typeof entry.messageId === "string")
  );
}

let persistenceFailureLogged = false;
function reportFailure(scope: string, err: unknown): void {
  if (persistenceFailureLogged) {
    return;
  }
  persistenceFailureLogged = true;
  logVerbose(`imessage echo-cache: ${scope} disabled after first failure: ${String(err)}`);
}

function readRecentEntries(): PersistedEchoEntry[] {
  const cutoff = Date.now() - PERSISTED_ECHO_TTL_MS;
  try {
    return PERSISTED_ECHO_STORE.entries()
      .map((entry) => entry.value)
      .filter(
        (entry): entry is PersistedEchoEntry =>
          isPersistedEchoEntry(entry) && entry.timestamp >= cutoff,
      )
      .slice(-MAX_PERSISTED_ECHO_ENTRIES);
  } catch (err) {
    reportFailure("read", err);
    return [];
  }
}

function appendEntry(entry: PersistedEchoEntry): void {
  try {
    PERSISTED_ECHO_STORE.register(persistedEchoEntryKey(entry), toPersistedEchoEntry(entry), {
      ttlMs: PERSISTED_ECHO_TTL_MS,
    });
  } catch (err) {
    reportFailure("append", err);
  }
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
  appendEntry(entry);
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

export function resetPersistedIMessageEchoCacheForTest(): void {
  persistenceFailureLogged = false;
  if (!process.env.OPENCLAW_STATE_DIR) {
    return;
  }
  try {
    PERSISTED_ECHO_STORE.clear();
  } catch {
    // best-effort
  }
}
