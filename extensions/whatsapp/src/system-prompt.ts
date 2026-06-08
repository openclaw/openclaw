// Whatsapp plugin module implements system prompt behavior.
export function resolveWhatsAppGroupSystemPrompt(params: {
  accountConfig?: {
    dangerouslyAllowGroupNameMatching?: boolean;
    groups?: Record<string, { systemPrompt?: string | null }>;
  } | null;
  groupId?: string | null;
  groupSubject?: string | null;
}): string | undefined {
  const groupIds = [
    params.groupId,
    ...(params.accountConfig?.dangerouslyAllowGroupNameMatching === true
      ? [params.groupSubject]
      : []),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (groupIds.length === 0) {
    return undefined;
  }
  const groups = params.accountConfig?.groups;
  for (const groupId of Array.from(new Set(groupIds))) {
    if (!groups || !Object.hasOwn(groups, groupId)) {
      continue;
    }
    const specific = groups[groupId];
    if (specific?.systemPrompt != null) {
      return specific.systemPrompt.trim() || undefined;
    }
    break;
  }
  const wildcard = groups?.["*"]?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
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
