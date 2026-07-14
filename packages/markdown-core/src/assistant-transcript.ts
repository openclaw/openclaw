// Assistant transcript annotations are produced after Markdown inline parsing and text joining.
import type MarkdownIt from "markdown-it";
import { HTML_TAG_RE } from "markdown-it/lib/common/html_re.mjs";
import type Token from "markdown-it/lib/token.mjs";
import {
  findAssistantTranscriptRoleHeaderSpans,
  type AssistantTranscriptRoleHeaderSpan,
} from "./assistant-transcript-headers.js";

export const ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE = "assistant_transcript_role_text";

export type AssistantTranscriptRoleTokenMeta = {
  assistantTranscriptRoleHeader: Omit<AssistantTranscriptRoleHeaderSpan, "start" | "end">;
};

export type AssistantTranscriptRoleImageMeta = {
  assistantTranscriptRoleImage: {
    /** Parsed visible label; annotation offsets are relative to this text. */
    text: string;
    spans: AssistantTranscriptRoleHeaderSpan[];
  };
};

type VisibleTokenProjection = {
  text: string;
  excludedRanges: Array<{ start: number; end: number }>;
};

type AssistantTranscriptRoleMarkdownOptions = {
  /** Trusted renderer tokens that contribute structure but no visible text. */
  isStructuralHtmlInline?: (token: Token) => boolean;
};

const RAW_CODE_CONTAINER_TAGS = new Set(["code", "pre", "script", "style", "textarea"]);

type RawCodeContainerTag = {
  closing: boolean;
  name: string;
  selfClosing: boolean;
};

function isAsciiTagNameCharacter(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    char === "-"
  );
}

function parseRawCodeContainerTag(rawTag: string): RawCodeContainerTag | null {
  if (rawTag[0] !== "<") {
    return null;
  }
  let cursor = 1;
  const closing = rawTag[cursor] === "/";
  if (closing) {
    cursor += 1;
  }
  const nameStart = cursor;
  while (isAsciiTagNameCharacter(rawTag[cursor])) {
    cursor += 1;
  }
  const name = rawTag.slice(nameStart, cursor).toLowerCase();
  if (!RAW_CODE_CONTAINER_TAGS.has(name)) {
    return null;
  }
  return {
    closing,
    name,
    selfClosing: rawTag.trimEnd().endsWith("/>"),
  };
}

function findRawCodeContainerRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const openTags: string[] = [];
  let rangeStart = -1;
  let cursor = 0;

  while (cursor < text.length) {
    const tagStart = text.indexOf("<", cursor);
    if (tagStart === -1) {
      break;
    }
    const match = text.slice(tagStart).match(HTML_TAG_RE);
    const rawTag = match?.[0];
    if (!rawTag) {
      cursor = tagStart + 1;
      continue;
    }
    const tag = parseRawCodeContainerTag(rawTag);
    if (tag?.closing) {
      const openIndex = openTags.lastIndexOf(tag.name);
      if (openIndex !== -1) {
        openTags.splice(openIndex);
        if (openTags.length === 0 && rangeStart !== -1) {
          ranges.push({ start: rangeStart, end: tagStart + rawTag.length });
          rangeStart = -1;
        }
      }
    } else if (tag && !tag.selfClosing) {
      if (openTags.length === 0) {
        rangeStart = tagStart;
      }
      openTags.push(tag.name);
    }
    cursor = tagStart + rawTag.length;
  }

  if (openTags.length > 0 && rangeStart !== -1) {
    ranges.push({ start: rangeStart, end: text.length });
  }
  return ranges;
}

function visibleTokenProjection(
  token: Token,
  options: AssistantTranscriptRoleMarkdownOptions,
): VisibleTokenProjection | null {
  if (token.type === "softbreak" || token.type === "hardbreak") {
    return { text: "\n", excludedRanges: [] };
  }
  if (token.type === "html_inline" && options.isStructuralHtmlInline?.(token) === true) {
    return null;
  }
  if (token.type === "text" || token.type === "html_inline") {
    return { text: token.content, excludedRanges: [] };
  }
  if (token.type === "code_inline") {
    return { text: token.content, excludedRanges: [{ start: 0, end: token.content.length }] };
  }
  if (token.type === "image") {
    return token.children && token.children.length > 0
      ? visibleTokensProjection(token.children, options)
      : { text: token.content, excludedRanges: [] };
  }
  return null;
}

function visibleTokensProjection(
  tokens: readonly Token[],
  options: AssistantTranscriptRoleMarkdownOptions,
): VisibleTokenProjection {
  let text = "";
  const excludedRanges: VisibleTokenProjection["excludedRanges"] = [];
  for (const token of tokens) {
    const projection = visibleTokenProjection(token, options);
    if (!projection) {
      continue;
    }
    const offset = text.length;
    text += projection.text;
    for (const range of projection.excludedRanges) {
      excludedRanges.push({ start: offset + range.start, end: offset + range.end });
    }
  }
  excludedRanges.push(...findRawCodeContainerRanges(text));
  return { text, excludedRanges };
}

function cloneToken(
  TokenType: typeof Token,
  source: Token,
  content: string,
  type: string = source.type,
): Token {
  const token = new TokenType(
    type,
    type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE ? "" : source.tag,
    0,
  );
  Object.assign(token, source);
  token.type = type;
  token.content = content;
  token.children = null;
  return token;
}

function annotatedToken(
  TokenType: typeof Token,
  source: Token,
  content: string,
  span: AssistantTranscriptRoleHeaderSpan,
): Token {
  const token = cloneToken(TokenType, source, content, ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE);
  token.meta = {
    ...(source.meta && typeof source.meta === "object" ? source.meta : {}),
    assistantTranscriptRoleHeader: {
      kind: span.kind,
      role: span.role,
    },
  } satisfies AssistantTranscriptRoleTokenMeta;
  return token;
}

function splitVisibleToken(params: {
  TokenType: typeof Token;
  token: Token;
  visibleStart: number;
  spanStartIndex: number;
  spans: readonly AssistantTranscriptRoleHeaderSpan[];
}): Token[] {
  const { token, visibleStart } = params;
  const visibleEnd = visibleStart + token.content.length;
  const firstSpan = params.spans[params.spanStartIndex];
  if (!firstSpan || firstSpan.start >= visibleEnd) {
    return [token];
  }

  const result: Token[] = [];
  let localCursor = 0;
  for (let spanIndex = params.spanStartIndex; spanIndex < params.spans.length; spanIndex += 1) {
    const span = params.spans[spanIndex];
    if (!span || span.start >= visibleEnd) {
      break;
    }
    if (span.end <= visibleStart) {
      continue;
    }
    const overlapStart = Math.max(span.start, visibleStart) - visibleStart;
    const overlapEnd = Math.min(span.end, visibleEnd) - visibleStart;
    if (overlapStart > localCursor) {
      result.push(
        cloneToken(params.TokenType, token, token.content.slice(localCursor, overlapStart)),
      );
    }
    if (overlapEnd > overlapStart) {
      result.push(
        annotatedToken(
          params.TokenType,
          token,
          token.content.slice(overlapStart, overlapEnd),
          span,
        ),
      );
    }
    localCursor = overlapEnd;
  }
  if (localCursor < token.content.length) {
    result.push(cloneToken(params.TokenType, token, token.content.slice(localCursor)));
  }
  return result;
}

function annotateInlineChildren(
  TokenType: typeof Token,
  children: Token[],
  preserveLinks: boolean,
  options: AssistantTranscriptRoleMarkdownOptions,
): Token[] {
  const projection = visibleTokensProjection(children, options);
  const spans = findAssistantTranscriptRoleHeaderSpans(projection.text, projection.excludedRanges);
  if (spans.length === 0) {
    return children;
  }

  const result: Token[] = [];
  let visibleCursor = 0;
  let spanCursor = 0;
  for (const token of children) {
    const tokenProjection = visibleTokenProjection(token, options);
    if (!tokenProjection) {
      result.push(token);
      continue;
    }
    const content = tokenProjection.text;
    for (;;) {
      const span = spans[spanCursor];
      if (!span || span.end > visibleCursor) {
        break;
      }
      spanCursor += 1;
    }
    if (token.type === "text" || token.type === "html_inline") {
      result.push(
        ...splitVisibleToken({
          TokenType,
          token,
          visibleStart: visibleCursor,
          spanStartIndex: spanCursor,
          spans,
        }),
      );
    } else if (token.type === "image") {
      const visibleEnd = visibleCursor + content.length;
      const imageSpans: AssistantTranscriptRoleHeaderSpan[] = [];
      for (let spanIndex = spanCursor; spanIndex < spans.length; spanIndex += 1) {
        const span = spans[spanIndex];
        if (!span || span.start >= visibleEnd) {
          break;
        }
        if (span.end <= visibleCursor) {
          continue;
        }
        imageSpans.push({
          ...span,
          start: Math.max(span.start, visibleCursor) - visibleCursor,
          end: Math.min(span.end, visibleEnd) - visibleCursor,
        });
      }
      if (imageSpans.length > 0) {
        token.meta = {
          ...(token.meta && typeof token.meta === "object" ? token.meta : {}),
          assistantTranscriptRoleImage: { text: content, spans: imageSpans },
        } satisfies AssistantTranscriptRoleImageMeta;
      }
      result.push(token);
    } else {
      result.push(token);
    }
    visibleCursor += content.length;
  }
  return preserveLinks ? result : removeLinksContainingAssistantTranscriptRoles(result);
}

function removeLinksContainingAssistantTranscriptRoles(tokens: Token[]): Token[] {
  const openLinks: Array<{ token: Token; containsRole: boolean }> = [];
  const suppressedLinks = new Set<Token>();
  for (const token of tokens) {
    if (token.type === "link_open") {
      openLinks.push({ token, containsRole: false });
      continue;
    }
    const imageMeta = (token.meta as AssistantTranscriptRoleImageMeta | undefined)
      ?.assistantTranscriptRoleImage;
    if (token.type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE || imageMeta?.spans.length) {
      for (const link of openLinks) {
        link.containsRole = true;
      }
      continue;
    }
    if (token.type !== "link_close") {
      continue;
    }
    const openLink = openLinks.pop();
    if (!openLink?.containsRole) {
      continue;
    }
    suppressedLinks.add(openLink.token);
    suppressedLinks.add(token);
  }

  const result: Token[] = [];
  for (const token of tokens) {
    if (suppressedLinks.has(token)) {
      continue;
    }
    const previous = result.at(-1);
    if (
      previous?.type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE &&
      token.type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE
    ) {
      previous.content += token.content;
      continue;
    }
    result.push(token);
  }
  return result;
}

function annotateHtmlBlock(TokenType: typeof Token, token: Token): Token[] {
  const spans = findAssistantTranscriptRoleHeaderSpans(
    token.content,
    findRawCodeContainerRanges(token.content),
  );
  if (spans.length === 0) {
    return [token];
  }
  return splitVisibleToken({ TokenType, token, visibleStart: 0, spanStartIndex: 0, spans });
}

/** Adds semantic transcript-role tokens to assistant-authored Markdown only. */
export function markdownItAssistantTranscriptRoles(
  md: MarkdownIt,
  options: AssistantTranscriptRoleMarkdownOptions = {},
): void {
  md.core.ruler.after("text_join", "assistant_transcript_roles", (state) => {
    if (state.env?.assistantTranscriptRoleHeaders !== true) {
      return;
    }
    const tokens: Token[] = [];
    const preserveLinks = state.env?.assistantTranscriptRolePreserveLinks === true;
    for (const token of state.tokens) {
      if (token.type === "inline" && token.children) {
        token.children = annotateInlineChildren(
          state.Token,
          token.children,
          preserveLinks,
          options,
        );
        tokens.push(token);
        continue;
      }
      if (token.type === "html_block") {
        tokens.push(...annotateHtmlBlock(state.Token, token));
        continue;
      }
      tokens.push(token);
    }
    state.tokens = tokens;
  });
}
