// Pure text helpers for memory tool output.
//
// Kept separate from tools.ts so tests do not pull in plugin-sdk imports that
// require a full dependency tree (e.g. undici via proxyline).

export function escapeMemoryForPrompt(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
