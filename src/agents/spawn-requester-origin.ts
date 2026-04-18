import type { ChatType } from "../channels/chat-type.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFirstBoundAccountId } from "../routing/bound-account-read.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";

// Delivery targets often carry a transport wrapper (e.g. Matrix `room:<id>` or
// LINE `line:group:<id>`), while route bindings commonly store raw peer ids on
// `match.peer.id`. Peel wrappers for those lookups, and separately pass the
// original target as an exact-match alias for channels whose canonical peer ids
// intentionally include prefixes such as `channel:` or `thread:`.
const KIND_PREFIX_TO_CHAT_TYPE: Readonly<Record<string, ChatType>> = {
  "room:": "channel",
  "channel:": "channel",
  "conversation:": "channel",
  "chat:": "channel",
  "thread:": "channel",
  "topic:": "channel",
  "group:": "group",
  "team:": "group",
  "user:": "direct",
  "dm:": "direct",
  "pm:": "direct",
};

// Matches one leading `<alpha-token>:` wrapper at a time.
const GENERIC_PREFIX_PATTERN = /^[a-z][a-z0-9_-]*:/i;

function shouldPeelRequesterPrefix(prefix: string, channelId: string | undefined): boolean {
  if (prefix in KIND_PREFIX_TO_CHAT_TYPE) {
    return true;
  }
  return Boolean(channelId && prefix === `${channelId.trim().toLowerCase()}:`);
}

export function extractRequesterPeer(
  channelId: string | undefined,
  requesterTo: string | undefined,
): { peerId?: string; peerKind?: ChatType } {
  if (!requesterTo) {
    return {};
  }
  const raw = requesterTo.trim();
  if (!raw) {
    return {};
  }
  let inferredKind: ChatType | undefined;
  if (channelId) {
    const plugin = getChannelPlugin(channelId);
    inferredKind = plugin?.messaging?.inferTargetChatType?.({ to: raw }) ?? undefined;
  }
  let value = raw;
  while (true) {
    const match = GENERIC_PREFIX_PATTERN.exec(value);
    if (!match) {
      break;
    }
    const prefix = match[0].toLowerCase();
    if (!shouldPeelRequesterPrefix(prefix, channelId)) {
      break;
    }
    if (prefix in KIND_PREFIX_TO_CHAT_TYPE) {
      inferredKind ??= KIND_PREFIX_TO_CHAT_TYPE[prefix];
    }
    value = value.slice(prefix.length).trim();
  }
  if (value) {
    // Id-embedded kind markers (Matrix `!`/`@`, IRC `#`) are authoritative
    // because channel wrappers can wrap either room or user ids.
    if (value.startsWith("@")) {
      inferredKind = "direct";
    } else if (value.startsWith("!") || value.startsWith("#")) {
      inferredKind = "channel";
    }
  }
  return { peerId: value || undefined, peerKind: inferredKind };
}

export function resolveRequesterOriginForChild(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentId: string;
  requesterChannel?: string;
  requesterAccountId?: string;
  requesterTo?: string;
  requesterThreadId?: string | number;
}) {
  const { peerId: normalizedPeerId, peerKind: inferredPeerKind } = extractRequesterPeer(
    params.requesterChannel,
    params.requesterTo,
  );
  const rawPeerIdAlias = params.requesterTo?.trim();
  // Same-agent spawns must keep the caller's active inbound account, not
  // re-resolve via bindings that may select a different account for the same
  // agent/channel.
  const boundAccountId =
    params.requesterChannel && params.targetAgentId !== params.requesterAgentId
      ? resolveFirstBoundAccountId({
          cfg: params.cfg,
          channelId: params.requesterChannel,
          agentId: params.targetAgentId,
          peerId: normalizedPeerId,
          exactPeerIdAliases:
            rawPeerIdAlias && rawPeerIdAlias !== normalizedPeerId ? [rawPeerIdAlias] : undefined,
          peerKind: inferredPeerKind,
        })
      : undefined;
  return normalizeDeliveryContext({
    channel: params.requesterChannel,
    accountId: boundAccountId ?? params.requesterAccountId,
    to: params.requesterTo,
    threadId: params.requesterThreadId,
  });
}
