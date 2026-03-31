import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";

function findSegmentAfter(pathname: string, marker: string): string | null {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const markerIndex = segments.findIndex((segment) => segment.toLowerCase() === marker);
  if (markerIndex < 0) {
    return null;
  }
  const nextSegment = segments[markerIndex + 1]?.trim();
  return nextSegment ? nextSegment : null;
}

export function resolveCampfireRoomIdFromTarget(target: string): string | null {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return null;
  }

  try {
    const url = new URL(normalizedTarget);
    return (
      findSegmentAfter(url.pathname, "rooms") ??
      findSegmentAfter(url.pathname, "buckets") ??
      findSegmentAfter(url.pathname, "chats")
    );
  } catch {
    return null;
  }
}

export function resolveCampfireOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const roomId = resolveCampfireRoomIdFromTarget(params.target);
  if (!roomId) {
    return null;
  }

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "campfire",
    accountId: params.accountId,
    peer: {
      kind: "group",
      id: roomId,
    },
    chatType: "group",
    from: `campfire:room:${roomId}`,
    to: `campfire:room:${roomId}`,
  });
}
