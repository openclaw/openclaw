/**
 * Strip internal implementation details from assistant text before it reaches
 * the web customer. This is a hard backstop behind the workspace prompt rule
 * ("不暴露内部实现细节"): when the model slips and narrates a workspace path or
 * an internal identifier, we remove it rather than let it confuse the client.
 *
 * Conservative by design — only high-signal, near-zero-false-positive tokens
 * are removed (workspace paths, the pipeline's injected `[userId:…]` context,
 * per-user agent session keys). General prose is left untouched.
 */

/** Internal workspace directories that mark a path as a system artifact. */
const INTERNAL_DIRS = ["memory", "templates", "workspace", "sessions", "skills", "state"];

const DIR_ALT = INTERNAL_DIRS.join("|");

/**
 * Backtick-wrapped internal reference, optionally preceded by a Chinese lead-in
 * verb ("保存在 `memory/…md`"). Removing the lead-in too keeps the sentence from
 * collapsing into "保存在。". The span must look internal: contain a known dir or
 * a doc/data extension.
 */
const BACKTICKED_INTERNAL = new RegExp(
  "(?:已?保存(?:在|到|至)|存(?:放|储|档)(?:在|到|至)?|位于|路径(?:为|是)?[：:]?|文件(?:名|为)?[：:]?|详?见|参见)?\\s*" +
    "`[^`]*(?:(?:" +
    DIR_ALT +
    ")/|\\.(?:md|jsonl?|log|ya?ml|sql))[^`]*`",
  "g",
);

/**
 * Bare (un-backticked) path rooted at an internal directory. The lookbehind
 * keeps us from stripping a `/memory/` segment that lives inside a customer URL
 * (e.g. an article link "https://weibo.com/.../sessions/123") — we only match
 * when the internal dir starts at a real boundary, not mid-path.
 */
const BARE_INTERNAL_PATH = new RegExp("(?<![\\w/:.\\-])(?:" + DIR_ALT + ")/[\\w./\\-]+", "g");

/** The runtime root itself, e.g. "~/.openclaw/credentials" or ".openclaw/openclaw.json". */
const OPENCLAW_ROOT = /~?\/?\.openclaw\/[\w./\-]+/g;

/** The chat pipeline injects these context prefixes; a confused model may echo them. */
const INJECTED_CONTEXT = /\[(?:userId|topicId|topicName|useSlaveTopic|allTopics)[^\]]*\]/g;

/** Per-user agent session keys / agent ids, e.g. `agent:rabbitmq-126:rabbitmq:126:…` or `rabbitmq-126`. */
const AGENT_SESSION_KEY = /\bagent:[\w.\-]+(?::[\w.\-]+)+/g;
const AGENT_ID = /\brabbitmq-\d+\b/g;

/**
 * Tidy punctuation/whitespace left behind after a span is removed, so a stripped
 * clause doesn't leave "，。" or doubled spaces. Intentionally light — never
 * rewrites surviving content.
 */
function tidy(text: string): string {
  return (
    text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([，。、；：,.;:])/g, "$1")
      .replace(/，\s*。/g, "。")
      .replace(/，\s*，/g, "，")
      .replace(/(^|\n)[ \t]+/g, "$1")
      .replace(/[ \t]+(\n|$)/g, "$1")
      // Drop a line that became only punctuation after a whole-sentence removal.
      .replace(/(^|\n)[ \t]*[，。、；：,.;:]+[ \t]*(?=\n|$)/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Remove internal references from a chunk of assistant text. Pure: returns a new
 * string, never mutates. Safe to call on streaming fragments and on the final
 * persisted response.
 */
export function sanitizeInternalRefs(text: string): string {
  // Defensive: callers should pass a string, but a non-string (e.g. a raw
  // content-block array) must never crash the chat pipeline via `.replace`.
  if (typeof text !== "string" || !text) {
    return typeof text === "string" ? text : "";
  }
  const stripped = text
    .replace(BACKTICKED_INTERNAL, "")
    .replace(OPENCLAW_ROOT, "")
    .replace(BARE_INTERNAL_PATH, "")
    .replace(INJECTED_CONTEXT, "")
    .replace(AGENT_SESSION_KEY, "")
    .replace(AGENT_ID, "");
  return tidy(stripped);
}
