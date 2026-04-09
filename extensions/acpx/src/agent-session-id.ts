const AGENT_SESSION_ID_META_KEYS = ["agentSessionId", "sessionId"] as const;

export function normalizeAgentSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asMetaRecord(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  return meta as Record<string, unknown>;
}

export function extractAgentSessionId(meta: unknown): string | undefined {
  const record = asMetaRecord(meta);
  if (!record) {
    return undefined;
  }

  for (const key of AGENT_SESSION_ID_META_KEYS) {
    const normalized = normalizeAgentSessionId(record[key]);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export { AGENT_SESSION_ID_META_KEYS };
