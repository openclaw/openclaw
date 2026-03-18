import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";

function stripZalouserTargetPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^(zalouser|zlu):/i, "")
    .trim();
}

function normalizePrefixedTarget(raw: string): string | undefined {
  const trimmed = stripZalouserTargetPrefix(raw);
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id ? `group:${id}` : undefined;
  }
  if (lower.startsWith("g:")) {
    const id = trimmed.slice("g:".length).trim();
    return id ? `group:${id}` : undefined;
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("dm:")) {
    const id = trimmed.slice("dm:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("u:")) {
    const id = trimmed.slice("u:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (/^g-\S+$/i.test(trimmed)) {
    return `group:${trimmed}`;
  }
  if (/^u-\S+$/i.test(trimmed)) {
    return `user:${trimmed}`;
  }

  return trimmed;
}

export function resolveZalouserOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizePrefixedTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = normalized.toLowerCase().startsWith("group:");
  const peerId = normalized.replace(/^(group|user):/i, "").trim();
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zalouser",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalouser:group:${peerId}` : `zalouser:${peerId}`,
    to: `zalouser:${peerId}`,
  });
}
