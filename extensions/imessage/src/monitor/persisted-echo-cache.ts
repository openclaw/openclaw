import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeIMessageMessageId } from "../message-guid.js";
import { createPersistenceFailureReporter } from "../persistence-failure.js";
import { getIMessageRuntime } from "../runtime.js";
import {
  IMESSAGE_SENT_ECHOES_TTL_MS,
  IMESSAGE_SENT_ECHOES_NAMESPACE,
  IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
  resolveIMessageSentEchoEntryKey,
  resolveIMessageEchoMediaKey,
  type PersistedEchoEntry,
} from "../state-contract.js";
import { normalizeIMessageEchoText } from "./echo-text-corruption.js";

type PersistedEchoStore = PluginStateKeyedStore<PersistedEchoEntry, 2>;

const reportFailure = createPersistenceFailureReporter("echo-cache");

function normalizeMedia(
  media: MediaPlaceholderTextFact | null | undefined,
): MediaPlaceholderTextFact | undefined {
  const key = resolveIMessageEchoMediaKey(media);
  if (!key) {
    return undefined;
  }
  const contentType = media?.contentType?.trim().toLowerCase() || undefined;
  const kind = media?.kind ?? undefined;
  return { ...(kind ? { kind } : {}), ...(contentType ? { contentType } : {}) };
}

function openPersistedEchoStore(): PersistedEchoStore {
  return getIMessageRuntime().state.openKeyedStoreV2<PersistedEchoEntry>({
    namespace: IMESSAGE_SENT_ECHOES_NAMESPACE,
    maxEntries: IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
  });
}

function remainingTtlMs(timestamp: number): number | undefined {
  const remaining = IMESSAGE_SENT_ECHOES_TTL_MS - Math.max(0, Date.now() - timestamp);
  return remaining > 0 ? remaining : undefined;
}

function isLiveEntry(entry: PersistedEchoEntry, now = Date.now()): boolean {
  const cutoff = now - IMESSAGE_SENT_ECHOES_TTL_MS;
  return entry.timestamp >= cutoff && (entry.expiresAt == null || entry.expiresAt > now);
}

async function readRecentEntries(): Promise<PersistedEchoEntry[]> {
  try {
    return (await openPersistedEchoStore().entries())
      .map(({ value }) => value)
      .filter((entry) => isLiveEntry(entry));
  } catch (err) {
    reportFailure("read", err);
    return [];
  }
}

async function persistEntry(
  entry: PersistedEchoEntry,
  ttlMs?: number,
): Promise<string | undefined> {
  if (!ttlMs) {
    return undefined;
  }
  const key = resolveIMessageSentEchoEntryKey(entry);
  try {
    await openPersistedEchoStore().register(key, entry, {
      ttlMs,
    });
  } catch (err) {
    reportFailure("write", err);
    return undefined;
  }
  return key;
}

export async function rememberPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  media?: MediaPlaceholderTextFact;
  messageId?: string;
  ttlMs?: number;
  pending?: boolean;
}): Promise<string | undefined> {
  const text = normalizeIMessageEchoText(params.text);
  const media = normalizeMedia(params.media);
  const messageId = normalizeIMessageMessageId(params.messageId);
  const entry: PersistedEchoEntry = {
    scope: params.scope,
    timestamp: Date.now(),
    ...(text ? { text } : {}),
    ...(media ? { media } : {}),
    ...(messageId ? { messageId } : {}),
    ...(params.pending ? { pending: true } : {}),
  };
  const ttlMs =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? params.ttlMs
      : undefined;
  if (ttlMs !== undefined) {
    entry.expiresAt = entry.timestamp + ttlMs;
  }
  if (!entry.text && !entry.media && !entry.messageId) {
    return undefined;
  }
  return await persistEntry(entry, ttlMs ?? remainingTtlMs(entry.timestamp));
}

export async function forgetPersistedIMessageEchoKey(key: string | undefined): Promise<void> {
  if (!key) {
    return;
  }
  try {
    await openPersistedEchoStore().delete(key);
  } catch (err) {
    reportFailure("delete", err);
  }
}

export async function hasPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  media?: MediaPlaceholderTextFact;
  messageId?: string;
  skipIdShortCircuit?: boolean;
  includePendingText?: boolean;
}): Promise<boolean> {
  const text = normalizeIMessageEchoText(params.text);
  const mediaKey = resolveIMessageEchoMediaKey(params.media);
  const messageId = normalizeIMessageMessageId(params.messageId);
  if (!text && !mediaKey && !messageId) {
    return false;
  }
  for (const entry of await readRecentEntries()) {
    if (entry.scope !== params.scope) {
      continue;
    }
    if (messageId && entry.messageId === messageId) {
      return true;
    }
    const hasConflictingMessageIds = Boolean(
      messageId && entry.messageId && messageId !== entry.messageId,
    );
    // Same-id echoes match on the messageId branch above. Known conflicting
    // GUIDs identify new messages, while no-GUID self-chat rows opt into text
    // fallback because their numeric SQLite IDs cannot equal outbound GUIDs.
    if (
      text &&
      (!hasConflictingMessageIds || params.skipIdShortCircuit) &&
      entry.text === text &&
      (!entry.pending || params.includePendingText)
    ) {
      return true;
    }
    if (
      mediaKey &&
      !hasConflictingMessageIds &&
      resolveIMessageEchoMediaKey(entry.media) === mediaKey &&
      (!entry.pending || params.includePendingText)
    ) {
      return true;
    }
  }
  return false;
}
