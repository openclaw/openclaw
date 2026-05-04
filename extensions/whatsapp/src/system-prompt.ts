type WhatsAppGroupEntry<T extends object> = T | null | undefined;

function resolveWhatsAppGroupEntry<T extends object>(params: {
  groups?: Record<string, WhatsAppGroupEntry<T>>;
  groupId?: string | null;
}): T | undefined {
  if (!params.groupId) {
    return undefined;
  }
  return params.groups?.[params.groupId] ?? params.groups?.["*"] ?? undefined;
}

export function resolveWhatsAppGroupSystemPrompt(params: {
  accountConfig?: { groups?: Record<string, { systemPrompt?: string | null }> } | null;
  groupId?: string | null;
}): string | undefined {
  if (!params.groupId) {
    return undefined;
  }
  const groups = params.accountConfig?.groups;
  const specific = groups?.[params.groupId];
  if (specific != null && specific.systemPrompt != null) {
    return specific.systemPrompt.trim() || undefined;
  }
  const wildcard = groups?.["*"]?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
}

export function resolveWhatsAppGroupVisibleReplies(params: {
  accountConfig?: {
    groups?: Record<
      string,
      { visibleReplies?: "automatic" | "message_tool" | null } | null | undefined
    >;
  } | null;
  groupId?: string | null;
}): "automatic" | "message_tool" | undefined {
  const entry = resolveWhatsAppGroupEntry({
    groups: params.accountConfig?.groups,
    groupId: params.groupId,
  });
  return entry?.visibleReplies ?? undefined;
}

export function resolveWhatsAppDirectSystemPrompt(params: {
  accountConfig?: { direct?: Record<string, { systemPrompt?: string | null }> } | null;
  peerId?: string | null;
}): string | undefined {
  if (!params.peerId) {
    return undefined;
  }
  const direct = params.accountConfig?.direct;
  const specific = direct?.[params.peerId];
  if (specific != null && specific.systemPrompt != null) {
    return specific.systemPrompt.trim() || undefined;
  }
  const wildcard = direct?.["*"]?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
}
