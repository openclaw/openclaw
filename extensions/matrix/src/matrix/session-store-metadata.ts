import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixDirectUserId, resolveMatrixTargetIdentity } from "./target-ids.js";

function resolveMatrixRoomTargetId(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const target = resolveMatrixTargetIdentity(trimmed);
  return target?.kind === "room" && target.id.startsWith("!") ? target.id : undefined;
}

type MatrixStoredSessionEntryLike = Pick<SessionEntry, "chatType" | "delivery">;

export function resolveMatrixStoredSessionMeta(entry?: MatrixStoredSessionEntryLike): {
  channel?: string;
  accountId?: string;
  roomId?: string;
  directUserId?: string;
} | null {
  if (!entry) {
    return null;
  }
  const deliveryContext = deliveryContextFromSession(entry);
  const origin = sessionDeliveryOrigin(entry);
  const channel =
    normalizeOptionalString(deliveryContext?.channel) ?? normalizeOptionalString(origin?.provider);
  const storedAccountId = normalizeOptionalString(deliveryContext?.accountId ?? origin?.accountId);
  const accountId = storedAccountId ? normalizeAccountId(storedAccountId) : undefined;
  const roomId =
    resolveMatrixRoomTargetId(deliveryContext?.to) ??
    resolveMatrixRoomTargetId(origin?.nativeChannelId) ??
    resolveMatrixRoomTargetId(origin?.to);
  const chatType =
    normalizeOptionalString(origin?.chatType) ?? normalizeOptionalString(entry.chatType);
  const directUserId =
    chatType === "direct"
      ? (normalizeOptionalString(origin?.nativeDirectUserId) ??
        resolveMatrixDirectUserId({
          from: normalizeOptionalString(origin?.from),
          to:
            (roomId ? `room:${roomId}` : undefined) ??
            normalizeOptionalString(deliveryContext?.to) ??
            normalizeOptionalString(origin?.to),
          chatType,
        }))
      : undefined;
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
