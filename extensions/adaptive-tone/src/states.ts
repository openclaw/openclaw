/**
 * Tone-state resolution: turn the detected signals into exactly one tone state.
 *
 * Keeping the output to a small, fixed, priority-ordered set is deliberate — it
 * keeps the injected guidance text stable (good for prompt caching, see
 * guidance.ts) and makes the behaviour auditable.
 */

import type { AdaptiveToneConfig } from "./config.js";
import { channelRegister, countRepeats, detectUnwell, timeBucket } from "./signals.js";

export type ToneState =
  | "gentle-care"
  | "patient-repeat"
  | "patient-light"
  | "quiet-latenight"
  | "professional"
  | "casual"
  | "neutral";

/** Minimal view of the hook event this resolver needs (decoupled from SDK types). */
export interface ToneSignalInput {
  prompt: string;
  messages: unknown[];
  channelId?: string;
}

/**
 * Resolve a single tone state. Priority (highest wins):
 *   wellbeing > repetition > time-of-day > channel/place > neutral.
 */
export function resolveToneState(
  input: ToneSignalInput,
  now: Date,
  config: AdaptiveToneConfig,
): ToneState {
  if (!config.enabled) return "neutral";

  if (config.wellbeing.enabled && detectUnwell(input.prompt, config)) {
    return "gentle-care";
  }

  if (config.repetition.enabled) {
    const repeats = countRepeats(input.prompt, input.messages, config);
    if (repeats >= 2) return "patient-repeat"; // asked 3+ times
    if (repeats === 1) return "patient-light"; // asked twice
  }

  if (config.time.enabled && timeBucket(now, config.time.timezone) === "late-night") {
    return "quiet-latenight";
  }

  if (config.place.enabled) {
    const register = channelRegister(input.channelId, config);
    if (register === "professional") return "professional";
    if (register === "casual") return "casual";
  }

  return "neutral";
}
