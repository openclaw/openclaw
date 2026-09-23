/**
 * Gemini Live native-audio models pick their spoken language per utterance and do not honor
 * `speechConfig.languageCode`. The only documented lever is the system instruction, so a caller
 * language hint (for example the Android client's `language: "en"`) becomes a soft reply-language
 * preference. It goes before the operator instructions so an operator-set reply language wins,
 * and it yields to a caller who asks to switch.
 */
const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

/** English display name for a BCP-47 tag or bare ISO 639 code, or undefined when it is not one. */
function resolveRealtimeLanguageName(language: string | undefined): string | undefined {
  const primary = language?.trim().split(/[-_]/)[0]?.toLowerCase();
  if (!primary || !/^[a-z]{2,3}$/.test(primary)) {
    return undefined;
  }
  let name: string | undefined;
  try {
    name = LANGUAGE_NAMES.of(primary);
  } catch {
    return undefined;
  }
  // Intl echoes unknown codes back unchanged instead of throwing.
  return name && name.toLowerCase() !== primary ? name : undefined;
}

/** Prepends the caller's reply-language preference to the realtime system instruction. */
export function buildGoogleRealtimeSystemInstruction(
  instructions: string | undefined,
  language: string | undefined,
): string | undefined {
  const name = resolveRealtimeLanguageName(language);
  if (!name) {
    return instructions;
  }
  // Wording and placement were probed against the Live models; small edits change the outcome.
  const preference =
    `Reply language: ${name} (the caller's device language). Respond in ${name} even when an ` +
    `utterance is transcribed as another language, because short or noisy audio is often ` +
    `transcribed in the wrong language. If the caller asks you to speak a different language, ` +
    `switch to it.`;
  return instructions?.trim() ? `${preference}\n\n${instructions.trim()}` : preference;
}
