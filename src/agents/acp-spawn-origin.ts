import { canonicalizeConversationContext } from "../infra/outbound/conversation-canonical.js";

export type SpawnOriginKind = "direct" | "thread" | "channel";

export type SpawnOrigin = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  originKind: SpawnOriginKind;
  deliveryTo?: string;
  deliveryThreadId?: string;
  currentBindingEligible: boolean;
};

export type ResolveSpawnOriginInput = {
  channel?: string | null;
  accountId?: string | null;
  threadId?: string | number | null;
  deliveryTo?: string | null;
  deliveryThreadId?: string | number | null;
  targets: Array<string | undefined | null>;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  threadParentId?: string | null;
};

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

export function resolveSpawnOrigin(
  params: ResolveSpawnOriginInput,
): { ok: true; origin: SpawnOrigin } | { ok: false; error: string } {
  const channel = normalizeText(params.channel)?.toLowerCase();
  if (!channel) {
    return {
      ok: false,
      error: "ACP thread binding requires a channel context.",
    };
  }

  const accountId = normalizeText(params.accountId) ?? "default";
  const conversation = canonicalizeConversationContext({
    channel,
    accountId,
    threadId: params.threadId,
    targets: params.targets,
    senderId: normalizeText(params.senderId),
    sessionKey: normalizeText(params.sessionKey),
    parentSessionKey: normalizeText(params.parentSessionKey),
    threadParentId: normalizeText(params.threadParentId),
  });
  const conversationId = normalizeText(conversation.conversationId);
  if (!conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${channel} conversation for ACP thread spawn.`,
    };
  }

  const originKind: SpawnOriginKind = normalizeThreadId(params.threadId)
    ? "thread"
    : conversation.chatType === "direct"
      ? "direct"
      : "channel";

  return {
    ok: true,
    origin: {
      channel,
      accountId,
      conversationId,
      parentConversationId: normalizeText(conversation.parentConversationId),
      originKind,
      deliveryTo: normalizeText(params.deliveryTo),
      deliveryThreadId: normalizeThreadId(params.deliveryThreadId),
      currentBindingEligible: conversation.currentBindingEligible,
    },
  };
}
