function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(feishu|lark):/i, "").trim();
}

function stripTargetKindPrefix(raw: string): string {
  return raw.replace(/^(chat|group|channel):/i, "").trim();
}

export function buildFeishuThreadConversationId(params: {
  chatId?: string;
  rootMessageId?: string | number | null;
}): string | undefined {
  const chatId = normalizeString(params.chatId);
  const rootMessageId =
    params.rootMessageId != null ? normalizeString(String(params.rootMessageId)) : undefined;
  if (!chatId || !rootMessageId) {
    return undefined;
  }
  return `${chatId}:thread:${rootMessageId}`;
}

export function parseFeishuConversationTarget(target: string): {
  chatId?: string;
  rootMessageId?: string;
} {
  const normalized = normalizeString(target);
  if (!normalized) {
    return {};
  }
  const strippedProvider = stripProviderPrefix(normalized);
  if (/^(user|dm|open_id):/i.test(strippedProvider)) {
    return {};
  }

  const withoutKind = stripTargetKindPrefix(strippedProvider);
  const threadMatch = /^(.*?):thread:(.+)$/.exec(withoutKind);
  if (threadMatch) {
    return {
      chatId: normalizeString(threadMatch[1]),
      rootMessageId: normalizeString(threadMatch[2]),
    };
  }

  return { chatId: normalizeString(withoutKind) };
}
