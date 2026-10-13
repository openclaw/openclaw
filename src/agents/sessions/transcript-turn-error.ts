/** Native agent and Gateway error surfaces can retain only the admission assertion text. */
export function isSessionTranscriptTurnMismatchErrorMessage(
  message: string | undefined,
): message is string {
  const text = message?.replace(/^Error: /, "") ?? "";
  return (
    /^Session transcript keyed user is outside the current turn: \S/.test(text) ||
    text === "Pending input is no longer active in its admitted transcript" ||
    text === "Pending input session changed before transcript promotion" ||
    text === "Pending input custody ended before transcript promotion"
  );
}
