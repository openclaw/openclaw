/**
 * Parses OpenClaw sessionKeys and resolves topic/key templates.
 *
 * SessionKey format: agent:{agentId}:{channel}:{accountId}:{peerKind}:{peerId}
 */

export type EventContext = {
  agentId: string;
  channel: string | null;
  accountId: string | null;
  peerKind: string | null;
  peerId: string | null;
  channelId: string | null;
  stream: string;
  runId: string;
  sessionKey: string;
};

const PEER_KINDS = new Set(["direct", "dm", "group", "channel"]);

/**
 * Parse a sessionKey into its component parts.
 * Returns null if the key doesn't start with "agent:".
 */
export function parseSessionKey(sessionKey: string): {
  agentId: string;
  channel: string | null;
  accountId: string | null;
  peerKind: string | null;
  peerId: string | null;
} | null {
  const parts = sessionKey.split(":").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "agent") {
    return null;
  }

  const agentId = parts[1];
  const rest = parts.slice(2);

  if (rest.length === 0) {
    return { agentId, channel: null, accountId: null, peerKind: null, peerId: null };
  }

  // Subagent keys (agent:<id>:subagent:<uuid>) and other non-channel
  // keys don't follow the channel/account/peer pattern. Only parse
  // channel routing fields from keys that start with a known channel token.
  if (rest[0] === "subagent" || rest[0] === "cron" || rest[0] === "acp") {
    return { agentId, channel: null, accountId: null, peerKind: null, peerId: null };
  }

  // Scan from the right — peer kind is always near the end of the key.
  // Scanning from the left would misparse accountIds that happen to
  // match a peer kind name (e.g. "direct" as an account name).
  let peerIdx = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (PEER_KINDS.has(rest[i])) {
      peerIdx = i;
      break;
    }
  }

  if (peerIdx === -1) {
    return {
      agentId,
      channel: rest[0] || null,
      accountId: rest.length > 1 ? rest[1] : null,
      peerKind: null,
      peerId: null,
    };
  }

  const prefix = rest.slice(0, peerIdx);
  return {
    agentId,
    channel: prefix[0] || null,
    accountId: prefix.length > 1 ? prefix[1] : null,
    peerKind: rest[peerIdx],
    peerId: rest.length > peerIdx + 1 ? rest.slice(peerIdx + 1).join(":") : null,
  };
}

/**
 * Resolve a topic pattern by replacing {variable} placeholders with context values.
 * Unknown or null fields resolve to "unknown".
 */
export function resolveTopic(pattern: string, ctx: EventContext): string {
  return pattern.replace(/\{(\w+)\}/g, (_, field) => {
    const value = ctx[field as keyof EventContext];
    return typeof value === "string" ? value : "unknown";
  });
}

/**
 * Resolve the Kafka record key from a named field.
 * Returns null if keyField is null/undefined (round-robin partitioning).
 */
export function resolveKey(keyField: string | null | undefined, ctx: EventContext): string | null {
  if (!keyField) return null;
  const value = ctx[keyField as keyof EventContext];
  return typeof value === "string" ? value : null;
}
