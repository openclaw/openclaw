function extractLegacyWhatsAppGroupId(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (trimmed.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id.toLowerCase().includes("@g.us") ? id : null;
  }
  if (!lower.includes("@g.us")) {
    return null;
  }
  if (!trimmed.includes(":")) {
    return trimmed;
  }
  if (lower.startsWith("whatsapp:") && !trimmed.includes(":group:")) {
    const remainder = trimmed.slice("whatsapp:".length).trim();
    const cleaned = remainder.replace(/^group:/i, "").trim();
    return cleaned || null;
  }
  return null;
}

export function isLegacyGroupSessionKey(key: string): boolean {
  return extractLegacyWhatsAppGroupId(key) !== null;
}

export function canonicalizeLegacySessionKey(params: {
  key: string;
  agentId: string;
}): string | null {
  const legacyGroupId = extractLegacyWhatsAppGroupId(params.key);
  return legacyGroupId
    ? `agent:${params.agentId}:whatsapp:group:${legacyGroupId}`.toLowerCase()
    : null;
}
