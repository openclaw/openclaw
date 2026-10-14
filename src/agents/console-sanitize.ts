// Console text sanitizer for short diagnostic strings. It removes control
// characters, flattens whitespace, and caps length before logging/display.
/** Sanitize optional text for compact console output. */
export function sanitizeForConsole(text: string | undefined, maxChars = 200): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed
    .replace(/\p{Cc}/gu, (control) => ("\r\n\t".includes(control) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = Array.from(sanitized);
  if (codePoints.length <= maxChars) {
    return sanitized;
  }
  // Cap on code-point boundaries so a maxChars cut never splits a surrogate pair (emoji/astral) and
  // leaves a lone surrogate before the ellipsis.
  return `${codePoints.slice(0, maxChars).join("")}…`;
}
