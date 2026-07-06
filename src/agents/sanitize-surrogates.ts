/** Removes unpaired UTF-16 surrogate code units while preserving valid pairs. */
export function sanitizeSurrogates(text: string): string {
  if (typeof text !== "string") {
    return "";
  }
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}
