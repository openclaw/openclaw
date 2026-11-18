/// <reference lib="es2024.string" />

/** Remove unpaired surrogates rejected by providers; preserve valid Unicode pairs. */
export function sanitizeSurrogates(text: string): string {
  if (text.isWellFormed()) {
    return text;
  }
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}
