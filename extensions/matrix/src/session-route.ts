import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveMatrixAccountConfig } from "./matrix/account-config.js";
import { resolveDefaultMatrixAccountId } from "./matrix/accounts.js";
import { resolveMatrixStoredSessionMeta } from "./matrix/session-store-metadata.js";
import {
  isMatrixQualifiedUserId,
  isMatrixRoomId,
  resolveMatrixTargetIdentity,
} from "./matrix/target-ids.js";

export async function resolveMatrixOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const target =
    resolveMatrixTargetIdentity(params.resolvedTarget?.to ?? params.target) ??
    resolveMatrixTargetIdentity(params.target);
  if (!target) {
    return null;
  }
  const effectiveAccountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMatrixAccountId(params.cfg),
  );
  const dmSessionScope =
    resolveMatrixAccountConfig({ cfg: params.cfg, accountId: effectiveAccountId }).dm
      ?.sessionScope ?? "per-user";
  async function resolveMatrixCurrentDmRoomId(targetUserId: string): Promise<string | undefined> {
    const sessionKey =
      parseThreadSessionSuffix(params.currentSessionKey).baseSessionKey ??
      params.currentSessionKey?.trim();
    if (!sessionKey) {
      return undefined;
    }
    try {
      const storePath = resolveStorePath(params.cfg.session?.store, {
        agentId: params.agentId,
      });
      const existing = await getSessionEntryAsync({
        storePath,
        sessionKey,
      });
      const currentSession = resolveMatrixStoredSessionMeta(existing);
      if (!currentSession) {
        return undefined;
      }
      if (currentSession.accountId && currentSession.accountId !== effectiveAccountId) {
        return undefined;
      }
      if (!currentSession.directUserId || currentSession.directUserId !== targetUserId) {
        return undefined;
      }
      return currentSession.roomId;
    } catch {
      return undefined;
    }
  }
  const roomScopedDmId =
    target.kind === "user" && dmSessionScope === "per-room"
      ? await resolveMatrixCurrentDmRoomId(target.id)
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

  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "matrix",
    accountId: effectiveAccountId,
    recipientSessionExact:
      target.kind === "room"
        ? dmSessionScope === "per-room" && isMatrixRoomId(target.id)
        : dmSessionScope === "per-user"
          ? isMatrixQualifiedUserId(target.id)
          : roomScopedDmId !== undefined,
    peer,
    chatType,
    from,
    to,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: baseRoute,
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    // Matrix m.thread identifies the session; m.in_reply_to may name a different child event.
    precedence: ["threadId", "replyToId", "currentSession"],
    normalizeThreadId: (threadId) => threadId,
    canRecoverCurrentThread: ({ route }) =>
      route.peer.kind !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
  });
}
