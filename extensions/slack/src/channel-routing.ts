import { buildThreadAwareOutboundSessionRoute } from "openclaw/plugin-sdk/channel-core";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import { resolveSlackAccount } from "./accounts.js";
import type { OpenClawConfig } from "./channel-api.js";
import { resolveSlackChannelType, resolveSlackConversationInfo } from "./channel-type.js";
import { resolveSlackEnterpriseUserTeamId } from "./enterprise-user-route.js";
import {
  canonicalizeSlackApiTargetId,
  formatSlackTarget,
  parseSlackTarget,
} from "./target-parsing.js";

function buildSlackBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "slack" });
}

function shouldRecoverSlackThreadFromCurrentSession(params: {
  cfg: OpenClawConfig;
  peerKind: RoutePeer["kind"];
}): boolean {
  // Shared DM sessions (dmScope="main") do not encode the DM peer in the base key,
  // so inheriting a prior thread can bleed across unrelated direct-message targets.
  if (params.peerKind === "direct" && (params.cfg.session?.dmScope ?? "main") === "main") {
    return false;
  }
  return true;
}

export async function resolveSlackOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  deliveryPurpose?: "heartbeat-owner";
  replyToId?: string | null;
  threadId?: string | number | null;
  currentSessionKey?: string | null;
  signal?: AbortSignal;
}) {
  const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const apiTargetId = canonicalizeSlackApiTargetId(parsed.kind, parsed.id, params.target);
  const isDm = parsed.kind === "user";
  if (
    params.deliveryPurpose === "heartbeat-owner" &&
    isDm &&
    !parsed.teamId &&
    /^[UW][A-Z0-9]{8,}$/.test(apiTargetId)
  ) {
    const teamId = await resolveSlackEnterpriseUserTeamId({
      cfg: params.cfg,
      accountId: params.accountId,
      userId: apiTargetId,
    });
    if (teamId) {
      parsed.teamId = teamId;
      parsed.id = apiTargetId;
    }
  }
  let peerKind: "direct" | "channel" | "group" = isDm ? "direct" : "channel";
  let peerId = formatSlackTarget(parsed);
  let recipientSessionExact = isDm
    ? /^[UW][A-Z0-9]{8,}$/i.test(parsed.id)
    : /^C[A-Z0-9]{8,}$/i.test(parsed.id);
  if (!isDm && /^D/i.test(parsed.id)) {
    const conversation = await resolveSlackConversationInfo({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: apiTargetId,
      teamId: parsed.teamId,
      signal: params.signal,
    });
    if (conversation.type !== "dm" || !conversation.user) {
      return null;
    }
    peerKind = "direct";
    peerId = formatSlackTarget({
      teamId: parsed.teamId,
      kind: "user",
      id: conversation.user,
    });
    recipientSessionExact = true;
  } else if (!isDm && /^G/i.test(parsed.id)) {
    const channelType = await resolveSlackChannelType({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: apiTargetId,
      teamId: parsed.teamId,
      signal: params.signal,
    });
    if (channelType === "group") {
      peerKind = "group";
    }
    if (channelType === "dm") {
      peerKind = "direct";
    }
    recipientSessionExact = channelType !== "unknown";
  }
  const peer: RoutePeer = {
    kind: peerKind,
    id: peerId,
  };
  const unpartitionedBaseSessionKey = buildSlackBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  const baseSessionKey =
    parsed.teamId && peerKind === "direct" && (params.cfg.session?.dmScope ?? "main") === "main"
      ? `${unpartitionedBaseSessionKey}:account:${encodeURIComponent(
          resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId }).accountId,
        ).toLowerCase()}:team:${encodeURIComponent(parsed.teamId).toLowerCase()}`
      : unpartitionedBaseSessionKey;
  return buildThreadAwareOutboundSessionRoute({
    route: {
      sessionKey: baseSessionKey,
      baseSessionKey,
      recipientSessionExact,
      peer,
      chatType: peerKind === "direct" ? ("direct" as const) : ("channel" as const),
      from:
        peerKind === "direct"
          ? `slack:${peerId}`
          : peerKind === "group"
            ? `slack:group:${peerId}`
            : `slack:channel:${peerId}`,
      to: parsed.teamId ? peerId : peerKind === "direct" ? `user:${peerId}` : `channel:${peerId}`,
    },
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    canRecoverCurrentThread: () =>
      shouldRecoverSlackThreadFromCurrentSession({
        cfg: params.cfg,
        peerKind,
      }),
  });
}
