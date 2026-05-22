//#region src/terminal/safe-text.d.ts
/**
 * Normalize untrusted text for single-line terminal/log rendering.
 */
declare function sanitizeTerminalText(input: string): string;
//#endregion
export { sanitizeTerminalText as t };