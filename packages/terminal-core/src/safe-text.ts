import { stripAnsi } from "./ansi.js";

/** Return whether text contains C0 or C1 terminal control characters. */
export function hasTerminalControl(input: string): boolean {
  return input.search(/\p{Cc}/u) !== -1;
}

/**
 * Normalize untrusted text for single-line rendering, including bidirectional controls.
 */
export function sanitizeTerminalText(input: string): string {
  // Strip escapes first so removed bytes cannot become a new ANSI sequence.
  return stripAnsi(input).replace(/[\p{Cc}\p{Bidi_Control}]/gu, (control) =>
    control === "\r" ? "\\r" : control === "\n" ? "\\n" : control === "\t" ? "\\t" : "",
  );
}

/** Format human output before styling: literals own layout, values cannot supply controls. */
export function terminalText(
  literals: TemplateStringsArray,
  ...values: (string | number | bigint | boolean | null | undefined)[]
): string {
  let result = "";
  let index = 0;
  for (const literal of literals) {
    result += literal;
    if (index < values.length) {
      result += sanitizeTerminalText(String(values[index++]));
    }
  }
  return result;
}
