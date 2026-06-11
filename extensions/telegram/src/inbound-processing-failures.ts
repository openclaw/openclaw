// Telegram plugin module records inbound processing failures that the turn
// pipeline swallows (logged + user apology) so `bot.handleUpdate()` resolves.
// The isolated-ingress spool consumer and the update tracker consult this
// registry to distinguish failed turns from completed ones; without it a
// failed turn is indistinguishable from success and the spooled update is
// deleted, silently losing the message.
const MAX_TRACKED_FAILURES = 256;

type TelegramInboundProcessingFailure = {
  error: unknown;
};

const failuresByKey = new Map<string, TelegramInboundProcessingFailure>();

function normalizeAccountId(accountId?: string): string {
  return accountId?.trim() || "default";
}

function buildFailureKey(params: {
  accountId?: string;
  chatId: number | string;
  messageId: number | string;
}): string {
  return `${normalizeAccountId(params.accountId)}:${params.chatId}:${params.messageId}`;
}

type TelegramUpdateMessageRef = {
  chatId: number;
  messageId: number;
};

function collectUpdateMessageRefs(update: unknown): TelegramUpdateMessageRef[] {
  if (!update || typeof update !== "object") {
    return [];
  }
  const candidates = update as Record<string, unknown>;
  const refs: TelegramUpdateMessageRef[] = [];
  for (const field of [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "business_message",
  ]) {
    const message = candidates[field];
    if (!message || typeof message !== "object") {
      continue;
    }
    const messageId = (message as { message_id?: unknown }).message_id;
    const chat = (message as { chat?: unknown }).chat;
    const chatId =
      chat && typeof chat === "object" ? (chat as { id?: unknown }).id : undefined;
    if (typeof messageId === "number" && typeof chatId === "number") {
      refs.push({ chatId, messageId });
    }
  }
  return refs;
}

/** Record a swallowed inbound processing failure for a chat message. */
export function recordTelegramInboundProcessingFailure(params: {
  accountId?: string;
  chatId: number | string;
  messageId: number | string;
  error: unknown;
}): void {
  const key = buildFailureKey(params);
  failuresByKey.delete(key);
  failuresByKey.set(key, { error: params.error });
  while (failuresByKey.size > MAX_TRACKED_FAILURES) {
    const oldest = failuresByKey.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    failuresByKey.delete(oldest);
  }
}

/** Drop stale failure records for an update before a fresh processing attempt. */
export function clearTelegramInboundProcessingFailureForUpdate(params: {
  accountId?: string;
  update: unknown;
}): void {
  for (const ref of collectUpdateMessageRefs(params.update)) {
    failuresByKey.delete(buildFailureKey({ accountId: params.accountId, ...ref }));
  }
}

/** Check whether the current processing attempt recorded a failure for an update. */
export function hasTelegramInboundProcessingFailureForUpdate(params: {
  accountId?: string;
  update: unknown;
}): boolean {
  return collectUpdateMessageRefs(params.update).some((ref) =>
    failuresByKey.has(buildFailureKey({ accountId: params.accountId, ...ref })),
  );
}

/** Consume the recorded failure for an update, if any. */
export function takeTelegramInboundProcessingFailureForUpdate(params: {
  accountId?: string;
  update: unknown;
}): TelegramInboundProcessingFailure | undefined {
  for (const ref of collectUpdateMessageRefs(params.update)) {
    const key = buildFailureKey({ accountId: params.accountId, ...ref });
    const failure = failuresByKey.get(key);
    if (failure) {
      failuresByKey.delete(key);
      return failure;
    }
  }
  return undefined;
}

export function resetTelegramInboundProcessingFailuresForTests(): void {
  failuresByKey.clear();
}
