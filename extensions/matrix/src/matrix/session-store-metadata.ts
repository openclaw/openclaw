import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMatrixTargetIdentity } from "./target-ids.js";

function trimMaybeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveMatrixRoomTargetId(value: unknown): string | undefined {
  const trimmed = trimMaybeString(value);
  if (!trimmed) {
    return undefined;
  }
  const target = resolveMatrixTargetIdentity(trimmed);
  return target?.kind === "room" && target.id.startsWith("!") ? target.id : undefined;
}

function resolveMatrixSessionAccountId(value: unknown): string | undefined {
  const trimmed = trimMaybeString(value);
  return trimmed ? normalizeAccountId(trimmed) : undefined;
}

function resolveMatrixStoredRoomId(params: {
  deliveryTo?: unknown;
  lastTo?: unknown;
  nativeChannelId?: unknown;
}): string | undefined {
  return (
    resolveMatrixRoomTargetId(params.deliveryTo) ??
    resolveMatrixRoomTargetId(params.lastTo) ??
    resolveMatrixRoomTargetId(params.nativeChannelId)
  );
}

type MatrixStoredSessionEntryLike = {
  deliveryContext?: {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
  };
  lastChannel?: unknown;
  lastTo?: unknown;
  lastAccountId?: unknown;
  chatType?: unknown;
  nativeChannelId?: unknown;
  nativeDirectUserId?: unknown;
};

export function resolveMatrixStoredSessionMeta(entry?: MatrixStoredSessionEntryLike): {
  channel?: string;
  accountId?: string;
  roomId?: string;
  directUserId?: string;
} | null {
  if (!entry) {
    return null;
  }
  const channel =
    trimMaybeString(entry.deliveryContext?.channel) ?? trimMaybeString(entry.lastChannel);
  const accountId =
    resolveMatrixSessionAccountId(entry.deliveryContext?.accountId ?? entry.lastAccountId) ??
    undefined;
  const roomId = resolveMatrixStoredRoomId({
    deliveryTo: entry.deliveryContext?.to,
    lastTo: entry.lastTo,
    nativeChannelId: entry.nativeChannelId,
  });
  const chatType = trimMaybeString(entry.chatType) ?? undefined;
  const directUserId =
    chatType === "direct" ? trimMaybeString(entry.nativeDirectUserId) : undefined;
  if (!channel && !accountId && !roomId && !directUserId) {
    return null;
  }
  return {
    ...(channel ? { channel } : {}),
    ...(accountId ? { accountId } : {}),
    ...(roomId ? { roomId } : {}),
    ...(directUserId ? { directUserId } : {}),
  };
}
