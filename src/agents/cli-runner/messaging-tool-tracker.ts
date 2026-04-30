import type { MessagingToolSend } from "../pi-embedded-messaging.types.js";

type CliMessagingToolSends = {
  targets: MessagingToolSend[];
  texts: string[];
  mediaUrls: string[];
};

const sendsByRunKey = new Map<string, CliMessagingToolSends>();

function createEmptySends(): CliMessagingToolSends {
  return { targets: [], texts: [], mediaUrls: [] };
}

function normalizeSessionKey(sessionKey?: string): string | undefined {
  const trimmed = sessionKey?.trim();
  return trimmed || undefined;
}

function buildTrackingKey(sessionKey?: string, runId?: string): string | undefined {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return undefined;
  }
  const normalizedRunId = runId?.trim();
  return normalizedRunId ? `${normalizedSessionKey}\0${normalizedRunId}` : normalizedSessionKey;
}

export function recordCliMessagingToolSend(params: {
  sessionKey?: string;
  runId?: string;
  target?: MessagingToolSend;
  text?: string;
  mediaUrls?: string[];
}): void {
  const trackingKey = buildTrackingKey(params.sessionKey, params.runId);
  if (!trackingKey) {
    return;
  }
  const existing = sendsByRunKey.get(trackingKey) ?? createEmptySends();
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
  sendsByRunKey.set(trackingKey, existing);
}

export function drainCliMessagingToolSends(
  sessionKey?: string,
  runId?: string,
): CliMessagingToolSends {
  const trackingKey = buildTrackingKey(sessionKey, runId);
  if (!trackingKey) {
    return createEmptySends();
  }
  const existing = sendsByRunKey.get(trackingKey);
  sendsByRunKey.delete(trackingKey);
  return existing ?? createEmptySends();
}

export function resetCliMessagingToolSendsForTest(): void {
  sendsByRunKey.clear();
}
