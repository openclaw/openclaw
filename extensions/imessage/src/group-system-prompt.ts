import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { formatIMessageChatTarget, normalizeIMessageHandle } from "./targets.js";

/**
 * Build candidate group keys for an inbound iMessage payload, in priority order.
 *
 * iMessage groups can be referenced by `chat_id` (numeric, persistent), `chat_guid`
 * (Apple-internal stable id), or `chat_identifier` (display name / handle alias).
 * Operators use whichever id they have visibility into, optionally with a
 * `chat_guid:` / `chat_identifier:` prefix to disambiguate.
 *
 * Returned candidates include:
 * - The numeric chat id (e.g. `"42"`) and its `chat_id:42` formatted form.
 * - The raw chat_guid plus its handle-normalized form, plus `chat_guid:<normalized>`.
 * - Same for chat_identifier.
 *
 * Duplicate values are skipped while preserving first-occurrence order.
 */
export function buildIMessageGroupKeyCandidates(params: {
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
}): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined): void => {
    const normalized = normalizeOptionalString(value);
    if (!normalized || candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  if (params.chatId !== undefined && Number.isFinite(params.chatId)) {
    push(String(params.chatId));
    push(formatIMessageChatTarget(params.chatId));
  }

  for (const [prefix, raw] of [
    ["chat_guid", params.chatGuid],
    ["chat_identifier", params.chatIdentifier],
  ] as const) {
    const trimmed = normalizeOptionalString(raw);
    if (!trimmed) {
      continue;
    }
    push(trimmed);
    if (!trimmed.toLowerCase().startsWith(`${prefix}:`)) {
      push(`${prefix}:${trimmed}`);
    }
    const normalized = normalizeIMessageHandle(trimmed);
    if (normalized && normalized !== trimmed) {
      push(normalized);
      if (!normalized.toLowerCase().startsWith(`${prefix}:`)) {
        push(`${prefix}:${normalized}`);
      }
    }
  }

  return candidates;
}

/**
 * Resolve the trusted per-group `systemPrompt` for an iMessage chat.
 *
 * Walks each candidate id from `buildIMessageGroupKeyCandidates`. The first
 * candidate whose key is *present* in `account.config.groups` (even with an
 * empty / whitespace-only value) wins — operators can deliberately suppress
 * any prompt for a specific chat by setting `systemPrompt: ""`. Only when no
 * candidate key is present does the wildcard `groups["*"].systemPrompt`
 * fallback kick in.
 *
 * Mirrors the established WhatsApp / BlueBubbles convention
 * (`extensions/whatsapp/src/system-prompt.ts`): `specific.systemPrompt != null`
 * suppresses the wildcard, then `trim() || undefined` normalizes the value.
 */
export function resolveIMessageGroupSystemPrompt(params: {
  account: ResolvedIMessageAccount;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
}): string | undefined {
  const groups = params.account.config.groups;
  if (!groups) {
    return undefined;
  }
  const candidates = buildIMessageGroupKeyCandidates({
    chatId: params.chatId,
    chatGuid: params.chatGuid,
    chatIdentifier: params.chatIdentifier,
  });
  for (const key of candidates) {
    const specific = groups[key];
    if (specific != null && specific.systemPrompt != null) {
      return specific.systemPrompt.trim() || undefined;
    }
  }
  const wildcard = groups["*"]?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
}
