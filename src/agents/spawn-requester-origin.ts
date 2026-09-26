/**
 * Spawn requester origin resolver.
 *
 * Normalizes delivery targets and route bindings so spawned runs can attribute the requesting account/channel.
 */
import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFirstBoundAccountId } from "../routing/bound-account-read.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";

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

function getKindForRequesterPrefix(prefix: string): ChatType | undefined {
  return Object.hasOwn(KIND_PREFIX_TO_CHAT_TYPE, prefix)
    ? KIND_PREFIX_TO_CHAT_TYPE[prefix]
    : undefined;
}

function normalizeChannelPrefix(channelId: string | undefined): string | undefined {
  const normalized = channelId?.trim().toLowerCase();
  return normalized ? `${normalized}:` : undefined;
}

function shouldPeelRequesterPrefix(prefix: string, channelPrefix: string | undefined): boolean {
  return Boolean(getKindForRequesterPrefix(prefix) || prefix === channelPrefix);
}

function inferPeerKindFromBareId(value: string): ChatType | undefined {
  if (value.startsWith("@")) {
    return "direct";
  }
  if (value.startsWith("!") || value.startsWith("#")) {
    return "channel";
  }
  return undefined;
}

function extractRequesterPeer(
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
  const channelPrefix = normalizeChannelPrefix(channelId);
  let inferredKind: ChatType | undefined;
  let allowBareIdKindOverride = false;
  let value = raw;
  while (true) {
    const match = GENERIC_PREFIX_PATTERN.exec(value);
    if (!match) {
      break;
    }
    const prefix = match[0].toLowerCase();
    if (!shouldPeelRequesterPrefix(prefix, channelPrefix)) {
      break;
    }
    const kindFromPrefix = getKindForRequesterPrefix(prefix);
    if (kindFromPrefix) {
      inferredKind ??= kindFromPrefix;
    }
    allowBareIdKindOverride ||= prefix === channelPrefix || prefix === "room:";
    value = value.slice(prefix.length).trim();
  }
  const bareIdKind = value ? inferPeerKindFromBareId(value) : undefined;
  if (bareIdKind && (!inferredKind || allowBareIdKindOverride)) {
    // Id-embedded kind markers (Matrix `!`/`@`, IRC `#`) are more specific
    // than transport wrapper text such as Matrix `room:@user`, which is a
    // direct peer. Explicit kind prefixes like `channel:` still win.
    inferredKind = bareIdKind;
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
  requesterGroupSpace?: string | null;
  requesterMemberRoleIds?: string[];
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
          groupSpace: params.requesterGroupSpace,
          memberRoleIds: params.requesterMemberRoleIds,
        })
      : undefined;
  return normalizeDeliveryContext({
    channel: params.requesterChannel,
    accountId: boundAccountId ?? params.requesterAccountId,
    to: params.requesterTo,
    threadId: params.requesterThreadId,
  });
}

/**
 * Raw requester conversation fields visible to a spawn path.
 *
 * CLI runtimes (e.g. claude-cli) issue loopback tool calls with no `agentTo`:
 * they identify the current conversation through the
 * `currentMessagingTarget`/`currentChannelId` and `currentThreadTs` fields.
 * Regular channel turns instead populate `agentTo`/`agentThreadId`. Delivery
 * follows the ambient current target, but thread binding is keyed to the
 * explicitly directed conversation (see resolver below): when a channel turn
 * names `agentTo` it must bind there even when ambient current-* fields also
 * exist; only when `agentTo` is absent (the CLI case) does binding fall back to
 * the same current-target fields delivery uses, so a CLI turn can bind while
 * completion/progress delivery already knows where to send.
 */
export type SpawnRequesterConversationSource = {
  /** Ambient per-turn messaging target; used for CLI turns without an explicit recipient. */
  currentMessagingTarget?: string;
  /** Current channel conversation id supplied to CLI loopback tools. */
  currentChannelId?: string;
  /** Explicit channel-turn recipient; always wins for thread binding when present. */
  agentTo?: string;
  /** Current thread timestamp/root supplied to CLI loopback tools. */
  currentThreadTs?: string | number;
  /** Explicit thread id resolved by regular channel turns; wins when present. */
  agentThreadId?: string | number;
};

function normalizeNonEmptySpawnConversationValue(
  value: string | number | undefined,
): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Thread ids keep their original numeric/string form for requester metadata;
// the binding path stringifies them itself when the channel needs text.
function normalizeNonEmptySpawnThreadValue(
  value: string | number | undefined,
): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves the requester conversation target/thread for spawn thread binding.
 *
 * Thread binding is keyed to the conversation the spawn is *explicitly*
 * directed at: an explicit channel-turn `agentTo`/`agentThreadId` always wins,
 * preserving existing binding behavior (a turn can name a target that differs
 * from the ambient current conversation). CLI runtimes never set `agentTo` and
 * identify the current conversation only through `currentMessagingTarget`/
 * `currentChannelId` and `currentThreadTs`; for those calls the resolver falls
 * back to the current target, then the current channel id — the same fields
 * delivery uses — so a CLI turn can bind a thread.
 */
export function resolveSpawnRequesterConversationTarget(source: SpawnRequesterConversationSource): {
  to?: string;
  threadId?: string | number;
} {
  const to =
    normalizeNonEmptySpawnConversationValue(source.agentTo) ??
    normalizeNonEmptySpawnConversationValue(source.currentMessagingTarget) ??
    normalizeNonEmptySpawnConversationValue(source.currentChannelId);
  const threadId =
    normalizeNonEmptySpawnThreadValue(source.agentThreadId) ??
    normalizeNonEmptySpawnThreadValue(source.currentThreadTs);
  return {
    ...(to ? { to } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
}
