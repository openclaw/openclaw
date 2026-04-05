import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/config-runtime";
import { resolveMatrixAccountConfig } from "./matrix/account-config.js";
import { resolveDefaultMatrixAccountId } from "./matrix/accounts.js";
import {
  resolveMatrixSessionAccountId,
  resolveMatrixStoredRoomId,
} from "./matrix/session-store-metadata.js";
import { resolveMatrixDirectUserId, resolveMatrixTargetIdentity } from "./matrix/target-ids.js";

function resolveEffectiveMatrixAccountId(
  params: Pick<ChannelOutboundSessionRouteParams, "cfg" | "accountId">,
): string {
  return normalizeAccountId(params.accountId ?? resolveDefaultMatrixAccountId(params.cfg));
}

function resolveMatrixDmSessionScope(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  accountId: string;
}): "per-user" | "per-room" {
  return (
    resolveMatrixAccountConfig({
      cfg: params.cfg,
      accountId: params.accountId,
    }).dm?.sessionScope ?? "per-user"
  );
}

function resolveMatrixCurrentDmRoomId(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  agentId: string;
  accountId: string;
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
    if (!currentAccountId || currentAccountId !== params.accountId) {
      return undefined;
    }
    const currentRoomId = resolveMatrixStoredRoomId({
      deliveryTo: existing.deliveryContext?.to,
      lastTo: existing.lastTo,
      originNativeChannelId: existing.origin?.nativeChannelId,
      originTo: existing.origin?.to,
    });
    const currentUserId = resolveMatrixDirectUserId({
      from: existing.origin?.from,
      to:
        (currentRoomId ? `room:${currentRoomId}` : undefined) ??
        existing.deliveryContext?.to ??
        existing.lastTo ??
        existing.origin?.to,
      chatType: existing.origin?.chatType ?? existing.chatType,
    });
    if (!currentUserId || currentUserId !== params.targetUserId) {
      return undefined;
    }
    return currentRoomId;
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
  const effectiveAccountId = resolveEffectiveMatrixAccountId(params);
  const roomScopedDmId =
    target.kind === "user" &&
    resolveMatrixDmSessionScope({
      cfg: params.cfg,
      accountId: effectiveAccountId,
    }) === "per-room"
      ? resolveMatrixCurrentDmRoomId({
          cfg: params.cfg,
          agentId: params.agentId,
          accountId: effectiveAccountId,
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
    accountId: effectiveAccountId,
    peer,
    chatType,
    from,
    to,
  });
}
