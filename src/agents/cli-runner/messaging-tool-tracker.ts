import type { MessagingToolSend } from "../pi-embedded-messaging.types.js";

type CliMessagingToolSends = {
  targets: MessagingToolSend[];
  texts: string[];
  mediaUrls: string[];
};

const sendsBySessionKey = new Map<string, CliMessagingToolSends>();

function createEmptySends(): CliMessagingToolSends {
  return { targets: [], texts: [], mediaUrls: [] };
}

function normalizeSessionKey(sessionKey?: string): string | undefined {
  const trimmed = sessionKey?.trim();
  return trimmed || undefined;
}

export function recordCliMessagingToolSend(params: {
  sessionKey?: string;
  target?: MessagingToolSend;
  text?: string;
  mediaUrls?: string[];
}): void {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const existing = sendsBySessionKey.get(sessionKey) ?? createEmptySends();
  if (params.target) {
    existing.targets.push(params.target);
  }
  const text = params.text?.trim();
  if (text) {
    existing.texts.push(text);
  }
  for (const mediaUrl of params.mediaUrls ?? []) {
    const trimmed = mediaUrl.trim();
    if (trimmed) {
      existing.mediaUrls.push(trimmed);
    }
  }
  sendsBySessionKey.set(sessionKey, existing);
}

export function drainCliMessagingToolSends(sessionKey?: string): CliMessagingToolSends {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    return createEmptySends();
  }
  const existing = sendsBySessionKey.get(normalized);
  sendsBySessionKey.delete(normalized);
  return existing ?? createEmptySends();
}

export function resetCliMessagingToolSendsForTest(): void {
  sendsBySessionKey.clear();
}
