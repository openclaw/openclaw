function stripProviderPrefix(raw: string): string {
  return raw.replace(/^lanxin:/i, "").trim();
}

export function normalizeLanxinTarget(raw: string): string | null {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("user:")) return trimmed.slice(5).trim() || null;
  if (lowered.startsWith("chat:")) return trimmed.slice(5).trim() || null;
  if (lowered.startsWith("group:")) return trimmed.slice(6).trim() || null;
  return trimmed;
}

export function looksLikeLanxinId(raw: string): boolean {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!trimmed) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) || trimmed.includes(":");
}

export type ParsedLanxinTarget =
  | {
      kind: "direct";
      userId: string;
      entryId: string;
    }
  | {
      kind: "group";
      groupId: string;
      entryId: string;
      userId?: string;
    };

export function parseLanxinTarget(raw: string): ParsedLanxinTarget | null {
  const normalized = stripProviderPrefix(raw);
  if (!normalized) return null;
  const parts = normalized
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  // Compatibility shorthand:
  // allow "userId:entryId" (without "user:" prefix) for direct messages.
  if (parts.length === 2) {
    const userId = parts[0];
    const entryId = parts[1];
    if (!userId || !entryId) return null;
    return { kind: "direct", userId, entryId };
  }
  if (parts.length < 3) return null;
  const scope = parts[0]?.toLowerCase();
  if (scope === "user" || scope === "direct" || scope === "dm") {
    const userId = parts[1];
    const entryId = parts[2];
    if (!userId || !entryId) return null;
    return { kind: "direct", userId, entryId };
  }
  if (scope === "group" || scope === "chat" || scope === "channel") {
    const groupId = parts[1];
    const entryId = parts[2];
    const userId = parts[3] || undefined;
    if (!groupId || !entryId) return null;
    return { kind: "group", groupId, entryId, userId };
  }
  return null;
}
