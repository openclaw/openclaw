import type { ImageContent } from "@mariozechner/pi-ai";
import { diagnosticLogger as diag } from "../../logging/diagnostic.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/**
 * Session-level message coalescing buffer.
 *
 * When multiple messages target the same session in rapid succession (possibly
 * from different channels), they queue up in the session command lane. Each
 * queued task would normally trigger a separate LLM call. This buffer allows
 * the first task that acquires the session lane to absorb all pending messages,
 * merging them into a single LLM call.
 *
 * Flow:
 * 1. Before enqueueing into the session lane, push an entry into this buffer.
 * 2. Inside the session lane (before the global lane), drain the buffer.
 * 3. If multiple entries were drained, merge prompts and proceed with one call.
 * 4. Subsequent tasks that find their entry already consumed return a no-op.
 */

export type SessionCoalesceEntry = {
  /** Unique token so we can detect whether our own entry was consumed. */
  token: string;
  prompt: string;
  images?: ImageContent[];
  /** Timestamp when the entry was pushed (for staleness checks). */
  pushedAt: number;
};

const COALESCE_STATE_KEY = Symbol.for("openclaw.sessionCoalesceState");

type CoalesceState = {
  buffers: Map<string, SessionCoalesceEntry[]>;
};

const state = resolveGlobalSingleton<CoalesceState>(COALESCE_STATE_KEY, () => ({
  buffers: new Map(),
}));

let tokenCounter = 0;

/** Generate a unique token for each coalesce entry. */
function nextToken(): string {
  return `sc-${Date.now().toString(36)}-${(++tokenCounter).toString(36)}`;
}

/**
 * Push a pending message into the session coalesce buffer.
 * Returns the entry token, which the caller uses to detect whether
 * its entry was consumed by another task's drain.
 */
export function pushSessionCoalesceEntry(
  sessionKey: string,
  entry: Omit<SessionCoalesceEntry, "token" | "pushedAt">,
): string {
  const token = nextToken();
  const fullEntry: SessionCoalesceEntry = {
    ...entry,
    token,
    pushedAt: Date.now(),
  };
  const existing = state.buffers.get(sessionKey);
  if (existing) {
    existing.push(fullEntry);
  } else {
    state.buffers.set(sessionKey, [fullEntry]);
  }
  diag.debug(
    `session-coalesce: pushed entry sessionKey=${sessionKey} token=${token} bufferSize=${(existing?.length ?? 0) + (existing ? 0 : 1)}`,
  );
  return token;
}

/**
 * Drain all pending entries for a session. Returns the entries and clears
 * the buffer. If the buffer is empty, returns an empty array.
 */
export function drainSessionCoalesceEntries(sessionKey: string): SessionCoalesceEntry[] {
  const entries = state.buffers.get(sessionKey);
  if (!entries || entries.length === 0) {
    state.buffers.delete(sessionKey);
    return [];
  }
  state.buffers.delete(sessionKey);
  diag.debug(`session-coalesce: drained sessionKey=${sessionKey} count=${entries.length}`);
  return entries;
}

/**
 * Check whether a specific token is still pending in the buffer
 * (i.e., has not been consumed by another task's drain).
 */
export function isCoalesceTokenPending(sessionKey: string, token: string): boolean {
  const entries = state.buffers.get(sessionKey);
  if (!entries) {
    return false;
  }
  return entries.some((e) => e.token === token);
}

/** Separator inserted between coalesced prompts. */
const COALESCE_SEPARATOR = "\n\n";

/**
 * Merge multiple coalesced entries into a single prompt + images array.
 * Preserves message ordering (first pushed = first in merged prompt).
 */
export function mergeCoalescedEntries(entries: SessionCoalesceEntry[]): {
  prompt: string;
  images: ImageContent[] | undefined;
} {
  if (entries.length === 0) {
    return { prompt: "", images: undefined };
  }
  if (entries.length === 1) {
    return {
      prompt: entries[0].prompt,
      images: entries[0].images,
    };
  }
  const prompts: string[] = [];
  const images: ImageContent[] = [];
  for (const entry of entries) {
    if (entry.prompt.trim()) {
      prompts.push(entry.prompt);
    }
    if (entry.images) {
      images.push(...entry.images);
    }
  }
  return {
    prompt: prompts.join(COALESCE_SEPARATOR),
    images: images.length > 0 ? images : undefined,
  };
}

/** Get the current buffer size for a session (for diagnostics). */
export function getSessionCoalesceBufferSize(sessionKey: string): number {
  return state.buffers.get(sessionKey)?.length ?? 0;
}

export const __testing = {
  resetBuffers() {
    state.buffers.clear();
    tokenCounter = 0;
  },
};
