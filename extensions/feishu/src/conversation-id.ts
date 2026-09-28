import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString as normalizeText,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeFeishuTarget, stripFeishuProviderPrefix } from "./targets.js";

export type FeishuGroupSessionScope =
  | "group"
  | "group_sender"
  | "group_topic"
  | "group_topic_sender";

const SCOPED_CONVERSATION_PATTERNS = [
  ["group_topic_sender", /^(?<chatId>.+):topic:(?<topicId>[^:]+):sender:(?<senderOpenId>[^:]+)$/i],
  ["group_topic", /^(?<chatId>.+):topic:(?<topicId>[^:]+)$/i],
  ["group_sender", /^(?<chatId>.+):sender:(?<senderOpenId>[^:]+)$/i],
] as const;

export function resolveConfiguredFeishuGroupSessionScope(params: {
  groupConfig?: {
    groupSessionScope?: FeishuGroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
  };
  feishuCfg?: {
    groupSessionScope?: FeishuGroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
  };
}): FeishuGroupSessionScope {
  const legacyTopicSessionMode =
    params.groupConfig?.topicSessionMode ?? params.feishuCfg?.topicSessionMode ?? "disabled";
  return (
    params.groupConfig?.groupSessionScope ??
    params.feishuCfg?.groupSessionScope ??
    (legacyTopicSessionMode === "enabled" ? "group_topic" : "group")
  );
}

export function buildFeishuConversationId(params: {
  chatId: string;
  scope: FeishuGroupSessionScope;
  senderOpenId?: string;
  topicId?: string;
}): string {
  const chatId = normalizeText(params.chatId) ?? "unknown";
  const senderOpenId = normalizeText(params.senderOpenId);
  const topicId = normalizeText(params.topicId);

  switch (params.scope) {
    case "group_sender":
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    case "group_topic":
      return topicId ? `${chatId}:topic:${topicId}` : chatId;
    case "group_topic_sender":
      if (topicId && senderOpenId) {
        return `${chatId}:topic:${topicId}:sender:${senderOpenId}`;
      }
      if (topicId) {
        return `${chatId}:topic:${topicId}`;
      }
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    default:
      return chatId;
  }
}

export function parseFeishuTargetId(raw: unknown): string | undefined {
  const target = normalizeText(raw);
  if (!target) {
    return undefined;
  }
  return normalizeFeishuTarget(target) || undefined;
}

export function parseFeishuDirectConversationId(raw: unknown): string | undefined {
  const target = normalizeText(raw);
  if (!target) {
    return undefined;
  }
  const withoutProvider = stripFeishuProviderPrefix(target);
  if (!withoutProvider) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(withoutProvider);
  for (const prefix of ["user:", "dm:", "open_id:"]) {
    if (lowered.startsWith(prefix)) {
      return normalizeText(withoutProvider.slice(prefix.length));
    }
  }
  const id = parseFeishuTargetId(target);
  if (!id) {
    return undefined;
  }
  if (id.startsWith("ou_") || id.startsWith("on_")) {
    return id;
  }
  return undefined;
}

export function parseFeishuConversationId(params: {
  conversationId: string;
  parentConversationId?: string;
}): {
  canonicalConversationId: string;
  chatId: string;
  topicId?: string;
  senderOpenId?: string;
  scope: FeishuGroupSessionScope;
} | null {
  const conversationId = normalizeText(params.conversationId);
  const parentConversationId = normalizeText(params.parentConversationId);
  if (!conversationId) {
    return null;
  }

  for (const [scope, pattern] of SCOPED_CONVERSATION_PATTERNS) {
    const fields = conversationId.match(pattern)?.groups;
    if (!fields?.chatId) {
      continue;
    }
    const parsed = {
      scope,
      chatId: fields.chatId,
      ...(fields.topicId !== undefined ? { topicId: fields.topicId } : {}),
      ...(fields.senderOpenId !== undefined ? { senderOpenId: fields.senderOpenId } : {}),
    };
    return {
      canonicalConversationId: buildFeishuConversationId(parsed),
      ...parsed,
    };
  }

  if (parentConversationId) {
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId: parentConversationId,
        scope: "group_topic",
        topicId: conversationId,
      }),
      chatId: parentConversationId,
      topicId: conversationId,
      scope: "group_topic",
    };
  }

  return {
    canonicalConversationId: conversationId,
    chatId: conversationId,
    scope: "group",
  };
}

export function buildFeishuModelOverrideParentCandidates(
  parentConversationId?: string | null,
): string[] {
  const rawId = normalizeText(parentConversationId);
  if (!rawId) {
    return [];
  }
  const parsed = parseFeishuConversationId({ conversationId: rawId });
  const chatId = normalizeLowercaseStringOrEmpty(parsed?.chatId);
  if (!chatId || parsed?.scope === "group") {
    return [];
  }
  if (parsed?.scope === "group_topic_sender") {
    const topicId = normalizeLowercaseStringOrEmpty(parsed.topicId);
    return topicId ? [`${chatId}:topic:${topicId}`, chatId] : [];
  }
  return [chatId];
}
