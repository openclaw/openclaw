export function isLegacyGroupSessionKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("group:")) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (!lower.includes("@g.us")) {
    return false;
  }
  if (!trimmed.includes(":")) {
    return true;
  }
  return lower.startsWith("whatsapp:") && !trimmed.includes(":group:");
}

export function canonicalizeLegacySessionKey(params: {
  key: string;
  agentId: string;
}): string | null {
  const trimmed = params.key.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id ? `agent:${params.agentId}:whatsapp:group:${id}`.toLowerCase() : null;
  }
  if (!trimmed.includes(":") && trimmed.toLowerCase().includes("@g.us")) {
    return `agent:${params.agentId}:whatsapp:group:${trimmed}`.toLowerCase();
  }
  if (trimmed.toLowerCase().startsWith("whatsapp:") && trimmed.toLowerCase().includes("@g.us")) {
    const remainder = trimmed.slice("whatsapp:".length).trim();
    const cleaned = remainder.replace(/^group:/i, "").trim();
    if (cleaned && !trimmed.includes(":group:")) {
      return `agent:${params.agentId}:whatsapp:group:${cleaned}`.toLowerCase();
    }
  }
  return null;
}
