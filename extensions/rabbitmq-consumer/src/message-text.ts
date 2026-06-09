/**
 * Extract plain text from a session message's `content`, which is a string in
 * simple sessions but an array of content blocks ([{type:"text", text}, ...])
 * in tool-using (autonomous) sessions.
 *
 * Shared within this extension by the chat pipeline and the LLM topic picker so
 * both read assistant replies the same way. (report-generator keeps its own
 * copy — extensions are self-contained packages and don't cross-import.)
 *
 * Reading only string content silently dropped block-array replies, which both
 * mis-routed topic picks (correct answer discarded) and — once the output
 * sanitizer started calling `.replace` — threw `text.replace is not a function`
 * when the raw array reached it. Always returns a string.
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object") {
          const b = block as { text?: unknown };
          if (typeof b.text === "string") {
            return b.text;
          }
        }
        return "";
      })
      .join("");
  }
  return "";
}
