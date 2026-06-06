/**
 * L2 · Outbound mention normalization layer.
 *
 * Identifies AI-output mention variants in text and converts them to the
 * standard `<at user_id="ou_xxx">Name</at>` format that Feishu post/md
 * messages accept.
 *
 * Rules (applied in priority order):
 *   1-4. `<at ...>` structural variants  — single-pass regex
 *   5.   `{"tag":"at","user_id":"ou_xxx"}` — post JSON leaked into text
 *   6.   `@ou_xxx`                         — raw openId
 *   7.   `@Name`                           — natural language, needs registry
 */

import { lookupMention } from "./mention-registry.js";

type NormalizeResult = {
  text: string;
  /** Names that matched rule 7 but could not be resolved via the registry. */
  failures: string[];
};

type LookupFn = (name: string) => string | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the canonical mention tag. Feishu uses two distinct `<at>` syntaxes:
 *  text/post messages use `<at user_id="..">Name</at>`, but lark_md *card*
 *  messages only notify with `<at id=..></at>` (see mention.ts). Emit the form
 *  matching the outbound payload, else the peer is not notified. Escape `<`/`>`
 *  in the display name so a name from an API/registry/model cannot break the
 *  markup (mirrors the inbound normalizer's escaping in bot-content.ts). */
function buildTag(openId: string, name?: string, opts?: { card?: boolean }): string {
  if (opts?.card) {
    return `<at id=${openId}></at>`;
  }
  const displayName = (name?.trim() || openId).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<at user_id="${openId}">${displayName}</at>`;
}

/** Identify code block regions to skip. */
function buildCodeBlockMask(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const fenced = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    regions.push([match.index, match.index + match[0].length]);
  }
  const inline = /`[^`]+`/g;
  while ((match = inline.exec(text)) !== null) {
    regions.push([match.index, match.index + match[0].length]);
  }
  return regions;
}

function isInsideCodeBlock(pos: number, regions: Array<[number, number]>): boolean {
  return regions.some(([start, end]) => pos >= start && pos < end);
}

function isEmailContext(text: string, atPos: number): boolean {
  if (atPos > 0 && /\w/.test(text[atPos - 1])) {
    const after = text.slice(atPos + 1, atPos + 50);
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(after)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pass 1: structural <at> tag variants (rules 1-4)
// ---------------------------------------------------------------------------

// Single regex that matches both closed <at ...>body</at> and unclosed
// <at ...>body variants in one pass. The non-greedy [^<]*? captures the body
// (text between > and the next < or end-of-string), then the alternation
// consumes </at> when present or uses a zero-width lookahead for unclosed tags.
// This avoids a two-pass approach where the second pass would operate on stale
// code-block regions after the first pass shifted text positions.
const AT_TAG_RE = /<at\s+([^>]+)>([^<]*?)(?:<\/at>|(?=<|$))/gi;

function extractOpenIdFromAttrs(attrs: string): { openId: string; isAll: boolean } | null {
  // Try user_id= first, then id=
  const userIdMatch = attrs.match(/user_id\s*=\s*['"]?([\w]+)['"]?/i);
  if (userIdMatch) {
    const id = userIdMatch[1];
    if (id.toLowerCase() === "all") {
      return { openId: "all", isAll: true };
    }
    if (id.startsWith("ou_")) {
      return { openId: id, isAll: false };
    }
  }
  const idMatch = attrs.match(/(?:^|\s)id\s*=\s*['"]?([\w]+)['"]?/i);
  if (idMatch) {
    const id = idMatch[1];
    if (id.toLowerCase() === "all") {
      return { openId: "all", isAll: true };
    }
    if (id.startsWith("ou_")) {
      return { openId: id, isAll: false };
    }
  }
  return null;
}

function normalizeAtTags(text: string, codeRegions: Array<[number, number]>): string {
  return text.replace(AT_TAG_RE, (match, attrs: string, body: string, offset: number) => {
    if (isInsideCodeBlock(offset, codeRegions)) {
      return match;
    }
    const parsed = extractOpenIdFromAttrs(attrs);
    if (!parsed) {
      return match;
    }
    if (parsed.isAll) {
      return '<at user_id="all">所有人</at>';
    }
    // Already canonical? Pass through.
    if (match === buildTag(parsed.openId, body)) {
      return match;
    }
    return buildTag(parsed.openId, body);
  });
}

// ---------------------------------------------------------------------------
// Pass 2: JSON at tags (rule 5)
// ---------------------------------------------------------------------------

const JSON_AT_RE = /\{\s*"tag"\s*:\s*"at"\s*,\s*"user_id"\s*:\s*"(ou_[a-zA-Z0-9]+)"[^}]*\}/g;

function normalizeJsonAtTags(text: string, codeRegions: Array<[number, number]>): string {
  return text.replace(JSON_AT_RE, (match, openId: string, offset: number) => {
    if (isInsideCodeBlock(offset, codeRegions)) {
      return match;
    }
    return buildTag(openId);
  });
}

// ---------------------------------------------------------------------------
// Pass 3: @ou_xxx (rule 6) and @Name (rule 7)
// ---------------------------------------------------------------------------

// Combined regex that matches @ followed by content. We distinguish ou_ prefix in the handler.
const AT_MENTION_RE =
  /(?<=^|[\s，。！？、；：（）【】""''…—\p{P}])@([^\s@<>{}"'`，。！？、；：（）【】]+)/gu;

function normalizeAtMentions(
  text: string,
  codeRegions: Array<[number, number]>,
  lookup: LookupFn,
  failures: string[],
): string {
  return text.replace(AT_MENTION_RE, (match, name: string, offset: number) => {
    if (isInsideCodeBlock(offset, codeRegions)) {
      return match;
    }
    if (isEmailContext(text, offset)) {
      return match;
    }
    // Skip if inside an already-normalized <at> tag
    const before = text.slice(Math.max(0, offset - 50), offset);
    if (/<at\s[^>]*$/.test(before)) {
      return match;
    }

    // Rule 6: @ou_xxx
    if (/^ou_[a-zA-Z0-9]+$/.test(name)) {
      return buildTag(name);
    }

    // Rule 7: @Name — registry lookup
    const openId = lookup(name);
    if (!openId) {
      failures.push(name);
      return match; // L3: preserve original text
    }
    return buildTag(openId, name);
  });
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

export function normalizeOutboundMentions(params: {
  text: string;
  accountId: string;
  chatId: string;
  lookup?: LookupFn;
}): NormalizeResult {
  const { text, accountId, chatId } = params;
  const failures: string[] = [];

  if (!text) {
    return { text, failures };
  }

  // Quick check: no mention-like content at all
  if (!text.includes("@") && !text.includes("<at") && !text.includes('"tag"')) {
    return { text, failures };
  }

  const lookup: LookupFn =
    params.lookup ?? ((name: string) => lookupMention({ accountId, chatId, name })?.openId);

  // Pass 1: structural <at> tags
  const codeRegions1 = buildCodeBlockMask(text);
  let result = normalizeAtTags(text, codeRegions1);

  // Pass 2: JSON at tags
  const codeRegions2 = buildCodeBlockMask(result);
  result = normalizeJsonAtTags(result, codeRegions2);

  // Pass 3: @-mentions
  const codeRegions3 = buildCodeBlockMask(result);
  result = normalizeAtMentions(result, codeRegions3, lookup, failures);

  return { text: result, failures };
}

/**
 * Guarantee the reply @mentions a specific entity. Feishu delivers a group
 * message to a bot only when it is @mentioned, so a bot-to-bot reply the model
 * forgot to tag would silently never reach the sender. Prepend the canonical
 * tag unless the (already-normalized) text mentions that openId in either
 * syntax. Pass `card: true` on lark_md card paths so the emitted tag actually
 * notifies the peer. Caller scopes this to bot senders in groups — never human
 * senders (that is the #71396 mention cascade this must not reintroduce).
 */
export function ensureMention(
  text: string,
  target: { openId: string; name?: string },
  opts?: { card?: boolean },
): string {
  const card = opts?.card === true;
  // Only a tag in the SAME syntax as the payload counts as already-mentioned: a
  // text-form `<at user_id>` in a lark_md card does not notify the peer, so on a
  // card path it must not satisfy the requirement (and vice versa).
  const alreadyMentioned = card
    ? text.includes(`<at id=${target.openId}`)
    : text.includes(`user_id="${target.openId}"`);
  if (alreadyMentioned) {
    return text;
  }
  const tag = buildTag(target.openId, target.name, { card });
  return text ? `${tag} ${text}` : tag;
}

/**
 * Rewrite text/post-form mention tags (`<at user_id="ou_..">..</at>`) into the
 * lark_md card form (`<at id=ou_..></at>`). Card messages notify a recipient
 * only via the `id=` form, but the outbound normalizer and the system prompt
 * both produce the `user_id=` form — so card/streaming-card paths must convert
 * before sending or the mentioned entity (incl. a peer bot) is never notified.
 */
export function toCardMentions(text: string): string {
  return text.replace(/<at\s+user_id="(ou_[A-Za-z0-9]+)"[^>]*>[^<]*<\/at>/gi, "<at id=$1></at>");
}
