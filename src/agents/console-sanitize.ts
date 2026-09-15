// Console text sanitizer for short diagnostic strings. It removes control
// characters, flattens whitespace, and caps length before logging/display.
/** Sanitize optional text for compact console output. */
export function sanitizeForConsole(text: string | undefined, maxChars = 200): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutControlChars = trimmed.replace(
    // oxlint-disable-next-line eslint/no-control-regex -- Console previews deliberately remove this exact ASCII control set.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );
  const sanitized = withoutControlChars
    .replace(/[\r\n\t]+/g, " ")
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
