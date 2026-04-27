import type { MessagingToolSend } from "../pi-embedded-messaging.types.js";

type CliMessagingToolSends = {
  targets: MessagingToolSend[];
  texts: string[];
};

const sendsBySessionKey = new Map<string, CliMessagingToolSends>();

function normalizeSessionKey(sessionKey?: string): string | undefined {
  const trimmed = sessionKey?.trim();
  return trimmed || undefined;
}

export function recordCliMessagingToolSend(params: {
  sessionKey?: string;
  target?: MessagingToolSend;
  text?: string;
}): void {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const existing = sendsBySessionKey.get(sessionKey) ?? { targets: [], texts: [] };
  if (params.target) {
    existing.targets.push(params.target);
  }
  const text = params.text?.trim();
  if (text) {
    existing.texts.push(text);
  }
  sendsBySessionKey.set(sessionKey, existing);
}

export function drainCliMessagingToolSends(sessionKey?: string): CliMessagingToolSends {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    return { targets: [], texts: [] };
  }
  const existing = sendsBySessionKey.get(normalized);
  sendsBySessionKey.delete(normalized);
  return existing ?? { targets: [], texts: [] };
}

export function resetCliMessagingToolSendsForTest(): void {
  sendsBySessionKey.clear();
}
