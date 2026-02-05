import type { FeishuIdType } from "./types.js";

const CHAT_ID_PREFIX = "oc_";
const OPEN_ID_PREFIX = "ou_";
const USER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function detectIdType(id: string): FeishuIdType | null {
  const trimmed = id.trim();
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return "chat_id";
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return "open_id";
  }
  if (USER_ID_REGEX.test(trimmed)) {
    return "user_id";
  }
  return null;
}

export function normalizeFeishuTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("chat:")) {
    return trimmed.slice("chat:".length).trim() || null;
  }
  if (lowered.startsWith("user:")) {
    return trimmed.slice("user:".length).trim() || null;
  }
  if (lowered.startsWith("open_id:")) {
    return trimmed.slice("open_id:".length).trim() || null;
  }

  return trimmed;
}

export function formatFeishuTarget(id: string, type?: FeishuIdType): string {
  const trimmed = id.trim();
  if (type === "chat_id" || trimmed.startsWith(CHAT_ID_PREFIX)) {
    return `chat:${trimmed}`;
  }
  if (type === "open_id" || trimmed.startsWith(OPEN_ID_PREFIX)) {
    return `user:${trimmed}`;
  }
  return trimmed;
}

export function resolveReceiveIdType(id: string): "chat_id" | "open_id" | "user_id" {
  const trimmed = id.trim();
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return "chat_id";
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return "open_id";
  }
  return "open_id";
}

export function looksLikeFeishuId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(chat|user|open_id):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return true;
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return true;
  }
  return false;
}
