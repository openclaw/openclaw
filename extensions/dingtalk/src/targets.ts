import type { DingtalkMessageContext } from "./types/index.ts";

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(dingtalk|dd|ding):/i, "").trim();
}

export function normalizeDingtalkTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const withoutProvider = stripProviderPrefix(trimmed);
  const lowered = withoutProvider.toLowerCase();
  if (lowered.startsWith("user:")) {
    return withoutProvider.slice("user:".length).trim() || null;
  }
  if (lowered.startsWith("group:")) {
    return withoutProvider.slice("group:".length).trim() || null;
  }

  return withoutProvider;
}

export function formatDingtalkTarget(id: string, type?: "user" | "group"): string {
  const trimmed = id.trim();
  if (type === "group") {
    return `group:${trimmed}`;
  }
  if (type === "user") {
    return `user:${trimmed}`;
  }
  return trimmed;
}

export function looksLikeDingtalkId(raw: string): boolean {
  const trimmed = stripProviderPrefix(raw.trim());
  if (!trimmed) {
    return false;
  }
  if (/^(user|group):/i.test(trimmed)) {
    return true;
  }
  return true;
}
