import type {
  ChannelOutboundSessionResolveParams,
  ChannelOutboundSessionResolveResult,
} from "openclaw/plugin-sdk";

function normalizeTlonShip(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
}

/**
 * Resolves outbound Tlon targets to canonical session-routing fields.
 * Kept parity-compatible with legacy core resolver during migration.
 */
export function resolveTlonOutboundSession(
  params: ChannelOutboundSessionResolveParams,
): ChannelOutboundSessionResolveResult | null {
  let trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^tlon:/i, "").trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  let isGroup =
    lower.startsWith("group:") || lower.startsWith("room:") || lower.startsWith("chat/");
  let peerId = trimmed;
  if (lower.startsWith("group:") || lower.startsWith("room:")) {
    peerId = trimmed.replace(/^(group|room):/i, "").trim();
    if (!peerId.startsWith("chat/")) {
      const parts = peerId.split("/").filter(Boolean);
      if (parts.length === 2) {
        peerId = `chat/${normalizeTlonShip(parts[0])}/${parts[1]}`;
      }
    }
    isGroup = true;
  } else if (lower.startsWith("dm:")) {
    peerId = normalizeTlonShip(trimmed.slice("dm:".length));
    isGroup = false;
  } else if (lower.startsWith("chat/")) {
    peerId = trimmed;
    isGroup = true;
  } else if (trimmed.includes("/")) {
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.length === 2) {
      peerId = `chat/${normalizeTlonShip(parts[0])}/${parts[1]}`;
      isGroup = true;
    }
  } else {
    peerId = normalizeTlonShip(trimmed);
  }

  return {
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `tlon:group:${peerId}` : `tlon:${peerId}`,
    to: `tlon:${peerId}`,
  };
}
