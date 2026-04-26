import type { SenderResolution } from "./daemon-client.js";
import { contextTypeFromSessionKey } from "./scope.js";

// Envelope shape — MUST match what bisque/skills/chat-history/scripts/
// search_context.py:allowed_scopes consumes. Drift here silently breaks
// recall scoping.
export type Envelope = {
  sender_role: string;
  is_owner: boolean;
  context_type: "dm" | "group";
  channel?: string;
  handle?: string;
  session_key?: string;
  user_id?: string;
  handle_display?: string;
  conversation_id?: string;
  resolved_at: string; // ISO-8601 — for debugging stale envelopes
  // Reserved for v7 §Pillar 1 owner-DM-unlock-in-group flow — surfaces
  // owner_dm rows in a group session when the owner explicitly asks.
  // Slice B leaves it unset; Phase 2 wires it up via a keyword trigger.
  owner_dm_unlock_for_turn?: boolean;
};

export function buildEnvelope(args: {
  resolution: SenderResolution;
  channel: string;
  handle: string;
  sessionKey?: string;
}): Envelope {
  return {
    sender_role: args.resolution.role || "stranger",
    is_owner: args.resolution.is_owner,
    context_type: contextTypeFromSessionKey(args.sessionKey),
    channel: args.channel,
    handle: args.handle,
    session_key: args.sessionKey,
    user_id: args.resolution.user_id || undefined,
    handle_display: args.resolution.handle_display || undefined,
    conversation_id: args.resolution.conversation_id || undefined,
    resolved_at: new Date().toISOString(),
  };
}

// Bounded LRU keyed by sessionKey. Per-session is the right grain —
// before_prompt_build fires per agent run within a session, and the
// session_key is the same across turns of one logical conversation.
// We keep the cap small because each agent pod typically handles a
// handful of concurrent sessions; the cap is defensive against leaks
// from sessions that never receive an explicit session_end.
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_TTL_MS = 60_000;

type CacheEntry = {
  envelope: Envelope;
  deadline: number;
};

export class EnvelopeCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.max = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  get(sessionKey: string): Envelope | undefined {
    const entry = this.entries.get(sessionKey);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.deadline) {
      this.entries.delete(sessionKey);
      return undefined;
    }
    // Promote to MRU position by re-insertion.
    this.entries.delete(sessionKey);
    this.entries.set(sessionKey, entry);
    return entry.envelope;
  }

  set(sessionKey: string, envelope: Envelope): void {
    this.entries.delete(sessionKey);
    this.entries.set(sessionKey, { envelope, deadline: Date.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  delete(sessionKey: string): void {
    this.entries.delete(sessionKey);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
