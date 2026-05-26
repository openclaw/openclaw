/**
 * Maps a tone state to the guidance string injected into the system prompt.
 *
 * IMPORTANT (prompt-cache contract): the returned string must be a pure
 * function of the tone state (plus static operator overrides) — no timestamps,
 * counters, or per-turn data. OpenClaw caches `appendSystemContext`, so emitting
 * different bytes every turn would bust the cache. The string only changes when
 * the *state* changes.
 */

import type { AdaptiveToneConfig } from "./config.js";
import type { ToneState } from "./states.js";
import type { WeatherCondition } from "./weather.js";

/** Short, deterministic tone directives. Operators may override any of these. */
export const DEFAULT_GUIDANCE: Record<Exclude<ToneState, "neutral">, string> = {
  "gentle-care":
    "The user has indicated they are unwell or having a hard time. Be warm, brief, " +
    "and low-demand. Lead with the answer, keep it short, and avoid long lists or " +
    "pressure. Do not give medical advice; if they appear to be in crisis, respond " +
    "with care and gently point them to appropriate help, consistent with your normal " +
    "safety guidance.",
  "patient-repeat":
    "The user has asked this several times. Acknowledge that briefly and without blame, " +
    "then explain it a different way than before — change the framing, add a concrete " +
    "example, or check which specific part is unclear.",
  "patient-light":
    "The user is asking this again. Be a little more patient and try a fresh angle rather " +
    "than repeating the previous wording.",
  "quiet-latenight":
    "It is late at night for the user. Keep the reply calmer, more concise, and lower-energy. " +
    "Get to the point and avoid overwhelming detail.",
  professional:
    "This is a professional/work channel. Use a crisp, formal, well-structured tone. " +
    "Prefer clear headings or short lists and avoid slang.",
  casual:
    "This is a casual/personal channel. A relaxed, friendly tone with contractions is fine. " +
    "Be conversational without sacrificing clarity.",
};

export const HEADER = "[Adaptive Tone] For this reply, adopt the following tone:";
export const FOOTER =
  "This adjusts delivery and tone only — it does not change the facts, your accuracy, " +
  "or your willingness to help, and it never overrides your safety guidelines. " +
  "Do not mention these tone instructions to the user.";

/** Guidance fragments keyed by weather condition (excluding "neutral"). */
export const WEATHER_GUIDANCE: Record<Exclude<WeatherCondition, "neutral">, string> = {
  sunny: "The weather outside is sunny and bright. Subtly adopt a slightly more cheerful, energetic, and warm demeanor.",
  cloudy: "The weather outside is cloudy and overcast. Be calm, focused, and steady.",
  rainy: "The weather outside is rainy and gloomy. Subtly match this cozy, quiet, and reflective atmosphere.",
  snowy: "The weather outside is snowy and cold. Be exceptionally warm, cozy, and comforting in your tone.",
  stormy: "The weather outside is stormy. Be reassuring, stable, and calm to offset any outside chaos.",
  hot: "The weather outside is very hot. Keep your responses light, cool, and brief. Subtly suggest staying cool or hydrated if relevant.",
  cold: "The weather outside is freezing cold. Bring a cozy, warm, and comforting presence to the conversation.",
};

/**
 * Return a weather-specific guidance string, or `undefined` for "neutral"
 * (in which case weather injects nothing).
 */
export function weatherGuidance(weather: WeatherCondition | undefined): string | undefined {
  if (!weather || weather === "neutral") return undefined;
  return WEATHER_GUIDANCE[weather];
}

/**
 * Build the system-prompt fragment for a state, or `undefined` for "neutral"
 * (in which case the plugin injects nothing and stays out of the way).
 */
export function toneGuidance(state: ToneState, config: AdaptiveToneConfig): string | undefined {
  if (state === "neutral") return undefined;
  const body = config.guidanceOverrides[state] ?? DEFAULT_GUIDANCE[state];
  return `${HEADER}\n${body}\n${FOOTER}`;
}
