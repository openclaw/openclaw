import type { ChannelGroupContext, GroupToolPolicyConfig } from "openclaw/plugin-sdk/lanxin";

/**
 * Resolve group tool policy for Lanxin.
 * Stub: returns undefined (open policy).
 */
export function resolveLanxinGroupToolPolicy(
  _params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  return undefined;
}

function normalizeAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  return trimmed
    .replace(/^(lanxin|user|group|chat):/i, "")
    .trim()
    .toLowerCase();
}

export function normalizeLanxinAllowlist(entries: Array<string | number> | undefined): string[] {
  return (entries ?? []).map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean);
}

export function resolveLanxinAllowlistMatch(params: {
  allowFrom: Array<string | number> | undefined;
  senderId: string;
}): { allowed: boolean } {
  const allowFrom = normalizeLanxinAllowlist(params.allowFrom);
  if (allowFrom.length === 0) return { allowed: false };
  if (allowFrom.includes("*")) return { allowed: true };
  const senderId = normalizeAllowEntry(params.senderId);
  return { allowed: allowFrom.includes(senderId) };
}
