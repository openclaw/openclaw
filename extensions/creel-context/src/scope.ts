// Mirrors bisque/skills/chat-history/scripts/index_sessions.py:scope_from_session_key.
// Both files MUST stay in sync — drift would silently break recall scoping.
//
// Scope labels:
//   owner_dm    — agent:main:main (owner converged DM across channels)
//   contact_dm  — session_key contains :dm: or :direct: (per-handle non-owner DM)
//   group       — session_key contains :group:
//   public_dm   — session_key starts with agent:main:public: (Globster discovery visitors)
//   unknown     — anything else (recall fail-closes for unknown shapes)

export type MemoryScope = "owner_dm" | "contact_dm" | "group" | "public_dm" | "unknown";

export function scopeFromSessionKey(sessionKey: string | undefined | null): MemoryScope {
  if (!sessionKey) {
    return "unknown";
  }
  if (sessionKey === "agent:main:main") {
    return "owner_dm";
  }
  if (sessionKey.startsWith("agent:main:public:")) {
    return "public_dm";
  }
  if (sessionKey.includes(":group:")) {
    return "group";
  }
  if (sessionKey.includes(":dm:") || sessionKey.includes(":direct:")) {
    return "contact_dm";
  }
  return "unknown";
}

// Derives a stable context_type for the envelope — consumed by
// search_context.py:allowed_scopes. group → group, everything else → dm.
export function contextTypeFromSessionKey(sessionKey: string | undefined | null): "dm" | "group" {
  return scopeFromSessionKey(sessionKey) === "group" ? "group" : "dm";
}
