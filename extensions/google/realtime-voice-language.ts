export function buildGoogleRealtimeSystemInstruction(
  instructions: string | undefined,
  hint: string | undefined,
): string | undefined {
  const language = hint?.trim().split(/[-_]/)[0]?.toLowerCase();
  const name =
    language && /^[a-z]{2,3}$/.test(language) && !["und", "mul", "zxx"].includes(language)
      ? new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(language)
      : undefined;
  if (!name) {
    return instructions;
  }
  // Live exposes no detection confidence or reply-language setting; guide the model once per session.
  const preference =
    `Reply language: ${name}. Respond in ${name} even when an utterance is transcribed as ` +
    "another language, because short or noisy audio can be mistranscribed. " +
    "If the caller clearly speaks at length in another language, follow that language. " +
    "If the caller asks you to speak a different language, switch to it.";
  return instructions ? `${preference}\n\n${instructions}` : preference;
}
