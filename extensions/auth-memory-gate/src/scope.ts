import type postgres from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScopeConfig = {
  requireVerified?: boolean;
  gateMessage?: string;
};

export type ScopeResult = {
  userId: string;
  externalId: string | null;
  scopeKey: string;
  verified: boolean;
  channel: string;
  peerId: string;
};

/** Minimal identity row from lp_users + lp_user_channels JOIN. */
type IdentityRow = {
  id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  channel: string;
  channel_peer_id: string;
  verified: boolean;
};

// ---------------------------------------------------------------------------
// Session key parsing — mirrors persist-user-identity convention
// ---------------------------------------------------------------------------

export function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts[2];
  }
  return "unknown";
}

/**
 * Extract the peer-specific portion of a session key.
 *
 * Session key formats:
 *   agent:{agentId}:direct:{peerId}
 *   agent:{agentId}:{channel}:direct:{peerId}
 *   agent:{agentId}:{channel}:{peerId...}
 *   agent:{agentId}:main  (shared — no peer)
 */
export function derivePeerId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") {
    return sessionKey;
  }
  const rest = parts.slice(2);
  const directIdx = rest.indexOf("direct");
  if (directIdx >= 0 && directIdx < rest.length - 1) {
    return rest.slice(directIdx + 1).join(":");
  }
  if (rest.length >= 2) {
    return rest.slice(1).join(":");
  }
  return rest[0] ?? sessionKey;
}

// ---------------------------------------------------------------------------
// Identity query — reads from persist-user-identity's lp_users table
// ---------------------------------------------------------------------------

/**
 * Look up a user by their channel-specific peer identifier.
 * Queries the same lp_users + lp_user_channels tables created by
 * persist-user-identity. Returns null if the peer is not registered.
 */
export async function findUserByChannelPeer(
  sql: postgres.Sql,
  channel: string,
  channelPeerId: string,
): Promise<IdentityRow | null> {
  const rows = await sql`
    SELECT u.id, u.external_id, u.first_name, u.last_name,
           uc.channel, uc.channel_peer_id,
           (u.external_id IS NOT NULL) AS verified
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${channelPeerId}
    LIMIT 1
  `;
  return (rows[0] as IdentityRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the memory scope for a given session.
 * Returns null when the peer cannot be identified (shared sessions, unknown).
 */
export function resolveScope(identity: IdentityRow, channel: string, peerId: string): ScopeResult {
  // Prefer external_id (cross-channel, from JWT sub) for the scope key.
  // Falls back to internal user UUID for channel-only users.
  const scopeKey = identity.external_id ?? identity.id;

  return {
    userId: identity.id,
    externalId: identity.external_id,
    scopeKey,
    verified: identity.verified,
    channel,
    peerId,
  };
}

// ---------------------------------------------------------------------------
// Scope block formatting — the contract downstream memory plugins read
// ---------------------------------------------------------------------------

/**
 * Format the memory scope block injected into prependContext.
 *
 * DOWNSTREAM CONTRACT: Memory plugins (Graphiti, LanceDB, pgvector) parse
 * this block to extract the scope key for per-user memory isolation.
 *
 * Format:
 *   [MEMORY_SCOPE]
 *   scope_key: <external_id or user_id>
 *   user_id: <uuid>
 *   external_id: <string|none>
 *   verified: <true|false>
 *   gated: <true|false>
 *   [/MEMORY_SCOPE]
 */
export function formatScopeBlock(scope: ScopeResult, config: ScopeConfig): string {
  // Gate check: if requireVerified and user is not verified, return gate message
  if (config.requireVerified && !scope.verified) {
    return formatGatedMessage(config);
  }

  return [
    "[MEMORY_SCOPE]",
    `scope_key: ${scope.scopeKey}`,
    `user_id: ${scope.userId}`,
    `external_id: ${scope.externalId ?? "none"}`,
    `verified: ${scope.verified}`,
    "gated: false",
    "[/MEMORY_SCOPE]",
  ].join("\n");
}

/**
 * Format the gate message when memory retrieval is blocked for unverified users.
 */
export function formatGatedMessage(config: ScopeConfig): string {
  const customMsg = config.gateMessage?.trim();

  const lines = ["[MEMORY_SCOPE]", "gated: true", "[/MEMORY_SCOPE]", ""];

  if (customMsg) {
    lines.push(customMsg);
  } else {
    lines.push(
      "Memory retrieval is not available until identity is verified.",
      "The user can verify by typing: !verify <token>",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hard gate — blocks agent conversation until user is identified
// ---------------------------------------------------------------------------

/**
 * System prompt injected via prependContext when hard gate is active
 * and user is unregistered. Forces the agent to only discuss verification.
 */
export function formatHardGateSystemPrompt(channel: string, peerId: string): string {
  return [
    "[IDENTITY_GATE]",
    "status: LOCKED",
    `channel: ${channel}`,
    `channel_peer_id: ${peerId}`,
    "[/IDENTITY_GATE]",
    "",
    "IMPORTANT: This user has NOT been identified. You MUST NOT proceed with any request",
    "until they verify their identity. Guide them through these steps:",
    "",
    "1. Greet the user warmly and welcome them to Syntropy Health",
    "2. Ask for their FIRST and LAST NAME as registered in the Syntropy Journals app",
    "3. Once they provide a name, tell them to type: !identify <first_name> <last_name>",
    "4. After identification, ask them to open Syntropy Journals → Settings → Pair Device",
    "5. Have them enter the 6-digit passcode here with: !verify <6-digit-code>",
    "",
    "IMPORTANT NOTES:",
    "- If the name doesn't match, remind them to use the EXACT name from their Syntropy Journals account",
    "- The 6-digit passcode expires in 10 minutes — tell them to generate a fresh one if needed",
    "- Do NOT answer any other questions until identity is verified",
    "- Be conversational and helpful about the verification process",
  ].join("\n");
}

/**
 * Short CTA appended to outgoing messages as a safety net
 * when the message_sending hook detects an unregistered user.
 */
export function formatHardGateReplyAppend(): string {
  return (
    "\n\n---\nTo get started, tell me your name or type " +
    "`!identify <first_name> <last_name>` to find your account."
  );
}
