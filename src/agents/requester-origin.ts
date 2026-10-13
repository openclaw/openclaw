import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { normalizeAccountId, normalizeOptionalAccountId } from "../routing/account-id.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";

/** Host-captured requester facts, independent of execution authority and agent grants. */
export type RequesterOrigin = Readonly<{
  sessionKey: string;
  operatorProfileId?: string;
  messageProvider?: string | null;
  accountId?: string | null;
  chatType?: ChatType;
  conversationId?: string | null;
  messageThreadId?: string | number | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: readonly string[];
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}>;

type RequesterOriginCaptureInput = Omit<Partial<RequesterOrigin>, "accountId" | "chatType"> & {
  requesterOrigin?: RequesterOrigin;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  chatType?: string;
};

type RequesterPrincipalFacts = {
  requesterOrigin?: RequesterOrigin;
  operatorAuthority?: { readonly profileId: string };
  operatorProfileId?: string;
  messageProvider?: string | null;
  messageChannel?: string | null;
  accountId?: string | null;
  agentAccountId?: string | null;
  senderId?: string | null;
  senderE164?: string | null;
};

/** Names the authenticated human, never a display label or execution session. */
export function resolveRequesterPrincipalKey(params: RequesterPrincipalFacts): string | undefined {
  const origin = params.requesterOrigin;
  const profileId = origin
    ? origin.operatorProfileId
    : (params.operatorAuthority?.profileId ?? params.operatorProfileId);
  if (profileId?.trim()) {
    return JSON.stringify(["operator", profileId.trim()]);
  }
  const channel = normalizeMessageChannel(
    origin ? origin.messageProvider : (params.messageProvider ?? params.messageChannel),
  );
  const facts = origin ?? params;
  const senderId =
    facts.senderId?.trim() ||
    (channel && ["whatsapp", "signal", "imessage"].includes(channel)
      ? facts.senderE164?.trim()
      : undefined);
  if (!channel || !senderId) {
    return undefined;
  }
  return JSON.stringify([
    channel,
    normalizeAccountId(origin ? origin.accountId : (params.accountId ?? params.agentAccountId)),
    senderId,
  ]);
}

const snapshotSet = (values: readonly string[] | undefined) =>
  values ? Object.freeze([...new Set(values)].toSorted()) : undefined;

/** Capture once at preparation; inherited facts never fall back to the receiver's route. */
export function captureRequesterOrigin(
  params: RequesterOriginCaptureInput,
): RequesterOrigin | undefined {
  const source = params.requesterOrigin;
  const sessionKey = source?.sessionKey ?? params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const facts = source ?? params;
  return Object.freeze({
    sessionKey,
    operatorProfileId: facts.operatorProfileId,
    messageProvider: normalizeMessageChannel(
      source ? source.messageProvider : (params.messageProvider ?? params.messageChannel),
    ),
    accountId: normalizeOptionalAccountId(source ? source.accountId : params.agentAccountId),
    chatType: normalizeChatType(facts.chatType),
    conversationId: facts.conversationId?.trim() || undefined,
    messageThreadId: facts.messageThreadId,
    groupId: facts.groupId,
    groupChannel: facts.groupChannel,
    groupSpace: facts.groupSpace,
    memberRoleIds: snapshotSet(facts.memberRoleIds),
    senderId: facts.senderId,
    senderName: facts.senderName,
    senderUsername: facts.senderUsername,
    senderE164: facts.senderE164,
  });
}

/** Compare authenticated requester identity; captured context and display facts are not identity. */
export function hasSameRequesterOrigin(left: RequesterOrigin, right: RequesterOrigin): boolean {
  const principal = resolveRequesterPrincipalKey({ requesterOrigin: left });
  return (
    principal !== undefined &&
    principal === resolveRequesterPrincipalKey({ requesterOrigin: right })
  );
}

/** Decode only protected host metadata; this validates shape, not authentication. */
export function decodeRequesterOrigin(value: unknown): RequesterOrigin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record = value;
  if (typeof record.sessionKey !== "string" || !record.sessionKey.trim()) {
    return undefined;
  }
  const facts: { -readonly [K in keyof RequesterOrigin]: RequesterOrigin[K] } = {
    sessionKey: record.sessionKey,
  };
  if (record.operatorProfileId !== undefined && typeof record.operatorProfileId !== "string") {
    return undefined;
  }
  facts.operatorProfileId = record.operatorProfileId;
  if (record.chatType !== undefined) {
    if (typeof record.chatType !== "string") {
      return undefined;
    }
    const chatType = normalizeChatType(record.chatType);
    if (!chatType) {
      return undefined;
    }
    facts.chatType = chatType;
  }
  for (const key of [
    "messageProvider",
    "accountId",
    "conversationId",
    "groupId",
    "groupChannel",
    "groupSpace",
    "senderId",
    "senderName",
    "senderUsername",
    "senderE164",
  ] as const) {
    const entry = record[key];
    if (entry !== undefined && entry !== null && typeof entry !== "string") {
      return undefined;
    }
    facts[key] = entry;
  }
  const thread = record.messageThreadId;
  if (
    thread !== undefined &&
    thread !== null &&
    typeof thread !== "string" &&
    !(typeof thread === "number" && Number.isSafeInteger(thread))
  ) {
    return undefined;
  }
  facts.messageThreadId = thread;
  const roles = record.memberRoleIds;
  if (roles !== undefined) {
    if (!Array.isArray(roles) || !roles.every((role): role is string => typeof role === "string")) {
      return undefined;
    }
    facts.memberRoleIds = roles;
  }
  return captureRequesterOrigin({ requesterOrigin: facts });
}
