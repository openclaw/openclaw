import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/config-runtime";
import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMatrixAccountConfig } from "./matrix/account-config.js";
import { resolveMatrixDirectUserId, resolveMatrixTargetIdentity } from "./matrix/target-ids.js";

function resolveMatrixDmSessionScope(
  params: Pick<ChannelOutboundSessionRouteParams, "cfg" | "accountId">,
): "per-user" | "per-room" {
  return (
    resolveMatrixAccountConfig({
      cfg: params.cfg,
      accountId: params.accountId,
    }).dm?.sessionScope ?? "per-user"
  );
}

function resolveMatrixRoomTargetId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const target = resolveMatrixTargetIdentity(value);
  return target?.kind === "room" && target.id.startsWith("!") ? target.id : undefined;
}

function resolveMatrixSessionAccountId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? normalizeAccountId(trimmed) : undefined;
}

function resolveMatrixCurrentDmRoomId(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  agentId: string;
  accountId?: string | null;
  currentSessionKey?: string;
  targetUserId: string;
}): string | undefined {
  const sessionKey = params.currentSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const store = loadSessionStore(storePath);
    const existing = resolveSessionStoreEntry({
      store,
      sessionKey,
    }).existing;
    if (!existing) {
      return undefined;
    }
    const currentAccountId =
      resolveMatrixSessionAccountId(
        existing.deliveryContext?.accountId ?? existing.lastAccountId ?? existing.origin?.accountId,
      ) ?? undefined;
    if (!currentAccountId || currentAccountId !== normalizeAccountId(params.accountId)) {
      return undefined;
    }
    const currentUserId = resolveMatrixDirectUserId({
      from: existing.origin?.from,
      to: existing.deliveryContext?.to ?? existing.lastTo ?? existing.origin?.to,
      chatType: existing.origin?.chatType ?? existing.chatType,
    });
    if (!currentUserId || currentUserId !== params.targetUserId) {
      return undefined;
    }
    return resolveMatrixRoomTargetId(
      existing.deliveryContext?.to ?? existing.lastTo ?? existing.origin?.to,
    );
  } catch {
    return undefined;
  }
}

export function resolveMatrixOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const target =
    resolveMatrixTargetIdentity(params.resolvedTarget?.to ?? params.target) ??
    resolveMatrixTargetIdentity(params.target);
  if (!target) {
    return null;
  }
  const roomScopedDmId =
    target.kind === "user" && resolveMatrixDmSessionScope(params) === "per-room"
      ? resolveMatrixCurrentDmRoomId({
          cfg: params.cfg,
          agentId: params.agentId,
          accountId: params.accountId,
          currentSessionKey: params.currentSessionKey,
          targetUserId: target.id,
        })
      : undefined;
  const peer =
    roomScopedDmId !== undefined
      ? { kind: "channel" as const, id: roomScopedDmId }
      : {
          kind: target.kind === "user" ? ("direct" as const) : ("channel" as const),
          id: target.id,
        };
  const chatType = target.kind === "user" ? "direct" : "channel";
  const from = target.kind === "user" ? `matrix:${target.id}` : `matrix:channel:${target.id}`;
  const to = `room:${roomScopedDmId ?? target.id}`;

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "matrix",
    accountId: params.accountId,
    peer,
    chatType,
    from,
    to,
  });
}
