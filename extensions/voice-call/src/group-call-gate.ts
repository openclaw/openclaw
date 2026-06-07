/**
 * Group-call "speak only when addressed" gate.
 *
 * In a 1:1 Teams call the assistant replies to everything. In a group/meeting call it should stay
 * quiet until someone actually addresses it — mirroring the chat channel's @mention gate
 * (`extensions/msteams/src/policy.ts`). A call has no structured @mention, so "addressed" is
 * inferred from the transcript: the speaker said one of the bot's wake phrases (its name). After
 * being addressed, a short follow-up window keeps the bot engaged for a natural back-and-forth
 * without re-stating its name every turn.
 *
 * This module is pure (no I/O) so it is unit-testable and shared by both the streaming and realtime
 * paths.
 */

/** Resolved gate policy for a call. */
export interface GroupCallGateConfig {
  /** Require the bot to be addressed by name before responding in a group call. */
  requireAddress: boolean;
  /** Phrases that count as addressing the bot (case-insensitive, boundary-aware). */
  wakePhrases: string[];
  /** After being addressed, keep responding without re-addressing for this many ms (0 = every turn). */
  followUpWindowMs: number;
}

/** Schema defaults for the gate, kept here so every caller resolves them the same way. */
export const GROUP_CALL_GATE_DEFAULTS: GroupCallGateConfig = {
  requireAddress: true,
  wakePhrases: ["assistant"],
  followUpWindowMs: 12_000,
};

/**
 * Apply {@link GROUP_CALL_GATE_DEFAULTS} to a possibly-partial/undefined config. Single source of
 * truth for the defaults so the config layer, runtime wiring, and provider don't each re-state them.
 */
export function resolveGroupCallGateConfig(
  raw: Partial<GroupCallGateConfig> | undefined,
): GroupCallGateConfig {
  return {
    requireAddress: raw?.requireAddress ?? GROUP_CALL_GATE_DEFAULTS.requireAddress,
    wakePhrases: raw?.wakePhrases ?? GROUP_CALL_GATE_DEFAULTS.wakePhrases,
    followUpWindowMs: raw?.followUpWindowMs ?? GROUP_CALL_GATE_DEFAULTS.followUpWindowMs,
  };
}

/**
 * Whether `transcript` addresses the bot by any wake phrase. Match is case-insensitive and
 * boundary-aware so "assistant" matches "Assistant, what's this?" but not "assistantship". An empty
 * phrase list never matches (caller decides what that means).
 */
export function isAddressed(transcript: string, wakePhrases: string[]): boolean {
  const text = transcript.toLowerCase();
  for (const phrase of wakePhrases) {
    const needle = phrase.trim().toLowerCase();
    if (!needle) {
      continue;
    }
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) {
        break;
      }
      const before = at === 0 ? "" : text[at - 1];
      const after = at + needle.length >= text.length ? "" : text[at + needle.length];
      // A boundary is the string edge or any non-letter/non-digit char, so punctuation and spaces
      // around the phrase count but an embedded substring (e.g. "assistantship") does not.
      if (!isWordChar(before) && !isWordChar(after)) {
        return true;
      }
      from = at + needle.length;
    }
  }
  return false;
}

function isWordChar(ch: string): boolean {
  return ch.length > 0 && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Decide whether the bot should respond to `transcript`.
 *
 * - Not a group call, or the gate is off, or no wake phrases configured → always respond (a gate
 *   with no trigger would mute the bot forever, so it is treated as disabled).
 * - Group call with the gate on → respond only if the turn addresses the bot, or we are still inside
 *   the follow-up window from a previous addressed turn.
 *
 * `lastAddressedAt` is the epoch-ms timestamp of the last addressed turn (undefined if never), and
 * `now` is the current epoch ms (injected for testability).
 */
export function shouldRespondToGroupTurn(params: {
  transcript: string;
  isGroup: boolean;
  config: GroupCallGateConfig;
  lastAddressedAt: number | undefined;
  now: number;
}): { respond: boolean; addressed: boolean; gated: boolean } {
  const { transcript, isGroup, config, lastAddressedAt, now } = params;
  const addressed = isAddressed(transcript, config.wakePhrases);
  const gateActive =
    isGroup && config.requireAddress && config.wakePhrases.some((p) => p.trim().length > 0);
  if (!gateActive) {
    return { respond: true, addressed, gated: false };
  }
  if (addressed) {
    return { respond: true, addressed: true, gated: true };
  }
  const inFollowUp =
    config.followUpWindowMs > 0 &&
    lastAddressedAt !== undefined &&
    now - lastAddressedAt <= config.followUpWindowMs;
  return { respond: inFollowUp, addressed: false, gated: true };
}
