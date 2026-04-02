import MarkdownIt from "markdown-it";
import { isAutoLinkedFileRef } from "openclaw/plugin-sdk/text-runtime";
import type { MatrixClient } from "./sdk.js";
import { isMatrixQualifiedUserId } from "./target-ids.js";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

md.enable("strikethrough");

const { escapeHtml } = md.utils;

export type MatrixMentions = {
  room?: boolean;
  user_ids?: string[];
};

type MarkdownToken = ReturnType<typeof md.parse>[number];
type MarkdownInlineToken = NonNullable<MarkdownToken["children"]>[number];
type MatrixMentionCandidate = {
  raw: string;
  start: number;
  end: number;
  kind: "room" | "user";
  userId?: string;
};

const ESCAPED_MENTION_SENTINEL = "\uE000";
const MENTION_PATTERN = /@room\b|@[A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]+(?::\d+)?/g;
const TRIMMABLE_MENTION_SUFFIX = /[),.!?:;\]]/;

function shouldSuppressAutoLink(
  tokens: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[0],
  idx: number,
): boolean {
  const token = tokens[idx];
  if (token?.type !== "link_open" || token.info !== "auto") {
    return false;
  }
  const href = token.attrGet("href") ?? "";
  const label = tokens[idx + 1]?.type === "text" ? (tokens[idx + 1]?.content ?? "") : "";
  return Boolean(href && label && isAutoLinkedFileRef(href, label));
}

md.renderer.rules.image = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");

md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.link_open = (tokens, idx, _options, _env, self) =>
  shouldSuppressAutoLink(tokens, idx) ? "" : self.renderToken(tokens, idx, _options);
md.renderer.rules.link_close = (tokens, idx, _options, _env, self) => {
  const openIdx = idx - 2;
  if (openIdx >= 0 && shouldSuppressAutoLink(tokens, openIdx)) {
    return "";
  }
  return self.renderToken(tokens, idx, _options);
};

function maskEscapedMentions(markdown: string): string {
  let masked = "";
  let idx = 0;
  let codeFenceLength = 0;

  while (idx < markdown.length) {
    if (markdown[idx] === "`") {
      let runLength = 1;
      while (markdown[idx + runLength] === "`") {
        runLength += 1;
      }
      if (codeFenceLength === 0) {
        codeFenceLength = runLength;
      } else if (runLength === codeFenceLength) {
        codeFenceLength = 0;
      }
      masked += markdown.slice(idx, idx + runLength);
      idx += runLength;
      continue;
    }
    if (codeFenceLength === 0 && markdown[idx] === "\\" && markdown[idx + 1] === "@") {
      masked += ESCAPED_MENTION_SENTINEL;
      idx += 2;
      continue;
    }
    masked += markdown[idx] ?? "";
    idx += 1;
  }

  return masked;
}

function restoreEscapedMentions(text: string): string {
  return text.replaceAll(ESCAPED_MENTION_SENTINEL, "@");
}

function isMentionStartBoundary(charBefore: string | undefined): boolean {
  return !charBefore || !/[A-Za-z0-9_]/.test(charBefore);
}

function trimMentionSuffix(match: MatrixMentionCandidate): MatrixMentionCandidate | null {
  let { raw, end } = match;
  while (raw.length > 1 && TRIMMABLE_MENTION_SUFFIX.test(raw.at(-1) ?? "")) {
    raw = raw.slice(0, -1);
    end -= 1;
  }
  if (!raw.startsWith("@") || raw === "@") {
    return null;
  }
  return { ...match, raw, end };
}

function buildMentionCandidate(raw: string, start: number): MatrixMentionCandidate | null {
  const isRoomMention = raw.toLowerCase() === "@room";
  const base: MatrixMentionCandidate = {
    raw,
    start,
    end: start + raw.length,
    kind: isRoomMention ? "room" : "user",
  };
  if (isRoomMention) {
    return trimMentionSuffix(base);
  }
  const userCandidate = isMatrixQualifiedUserId(raw) ? { ...base, userId: raw } : null;
  if (!userCandidate) {
    return null;
  }
  return trimMentionSuffix(userCandidate);
}

function collectMentionCandidates(text: string): MatrixMentionCandidate[] {
  const mentions: MatrixMentionCandidate[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? -1;
    if (start < 0 || !raw) {
      continue;
    }
    if (!isMentionStartBoundary(text[start - 1])) {
      continue;
    }
    const candidate = buildMentionCandidate(raw, start);
    if (!candidate) {
      continue;
    }
    mentions.push(candidate);
  }
  return mentions;
}

function createToken(
  sample: MarkdownInlineToken,
  type: string,
  tag: string,
  nesting: number,
): MarkdownInlineToken {
  const TokenCtor = sample.constructor as new (
    type: string,
    tag: string,
    nesting: number,
  ) => MarkdownInlineToken;
  return new TokenCtor(type, tag, nesting);
}

function createTextToken(sample: MarkdownInlineToken, content: string): MarkdownInlineToken {
  const token = createToken(sample, "text", "", 0);
  token.content = content;
  return token;
}

function createMentionLinkTokens(params: {
  sample: MarkdownInlineToken;
  href: string;
  label: string;
}): MarkdownInlineToken[] {
  const open = createToken(params.sample, "link_open", "a", 1);
  open.attrSet("href", params.href);
  const text = createTextToken(params.sample, params.label);
  const close = createToken(params.sample, "link_close", "a", -1);
  return [open, text, close];
}

function resolveMentionUserId(match: MatrixMentionCandidate): string | null {
  if (match.kind !== "user") {
    return null;
  }
  return match.userId ?? null;
}

function mutateInlineTokensWithMentions(params: {
  children: MarkdownInlineToken[];
  userIds: string[];
  seenUserIds: Set<string>;
  selfUserId: string | null;
}): { children: MarkdownInlineToken[]; roomMentioned: boolean } {
  const nextChildren: MarkdownInlineToken[] = [];
  let roomMentioned = false;
  let insideLinkDepth = 0;
  for (const child of params.children) {
    if (child.type === "link_open") {
      insideLinkDepth += 1;
      nextChildren.push(child);
      continue;
    }
    if (child.type === "link_close") {
      insideLinkDepth = Math.max(0, insideLinkDepth - 1);
      nextChildren.push(child);
      continue;
    }
    if (child.type !== "text" || insideLinkDepth > 0 || !child.content) {
      nextChildren.push(child);
      continue;
    }

    const visibleContent = restoreEscapedMentions(child.content);
    const matches = collectMentionCandidates(child.content);
    if (matches.length === 0) {
      nextChildren.push(createTextToken(child, visibleContent));
      continue;
    }

    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) {
        nextChildren.push(
          createTextToken(child, restoreEscapedMentions(child.content.slice(cursor, match.start))),
        );
      }
      cursor = match.end;
      if (match.kind === "room") {
        roomMentioned = true;
        nextChildren.push(createTextToken(child, match.raw));
        continue;
      }

      const resolvedUserId = resolveMentionUserId(match);
      if (!resolvedUserId || resolvedUserId === params.selfUserId) {
        nextChildren.push(createTextToken(child, match.raw));
        continue;
      }
      if (!params.seenUserIds.has(resolvedUserId)) {
        params.seenUserIds.add(resolvedUserId);
        params.userIds.push(resolvedUserId);
      }
      nextChildren.push(
        ...createMentionLinkTokens({
          sample: child,
          href: `https://matrix.to/#/${resolvedUserId}`,
          label: match.raw,
        }),
      );
    }
    if (cursor < child.content.length) {
      nextChildren.push(
        createTextToken(child, restoreEscapedMentions(child.content.slice(cursor))),
      );
    }
  }
  return { children: nextChildren, roomMentioned };
}

export function markdownToMatrixHtml(markdown: string): string {
  const rendered = md.render(markdown ?? "");
  return rendered.trimEnd();
}

async function resolveMarkdownMentionState(params: {
  markdown: string;
  client: MatrixClient;
  roomId: string;
}): Promise<{ tokens: MarkdownToken[]; mentions: MatrixMentions }> {
  const markdown = maskEscapedMentions(params.markdown ?? "");
  const tokens = md.parse(markdown, {});
  const selfUserId = await params.client.getUserId().catch(() => null);
  const userIds: string[] = [];
  const seenUserIds = new Set<string>();
  let roomMentioned = false;

  for (const token of tokens) {
    if (!token.children?.length) {
      continue;
    }
    const mutated = mutateInlineTokensWithMentions({
      children: token.children,
      userIds,
      seenUserIds,
      selfUserId,
    });
    token.children = mutated.children;
    roomMentioned ||= mutated.roomMentioned;
  }

  const mentions: MatrixMentions = {};
  if (userIds.length > 0) {
    mentions.user_ids = userIds;
  }
  if (roomMentioned) {
    mentions.room = true;
  }
  return {
    tokens,
    mentions,
  };
}

export async function resolveMatrixMentionsInMarkdown(params: {
  markdown: string;
  client: MatrixClient;
  roomId: string;
}): Promise<MatrixMentions> {
  const state = await resolveMarkdownMentionState(params);
  return state.mentions;
}

export async function renderMarkdownToMatrixHtmlWithMentions(params: {
  markdown: string;
  client: MatrixClient;
  roomId: string;
}): Promise<{ html?: string; mentions: MatrixMentions }> {
  const state = await resolveMarkdownMentionState(params);
  const html = md.renderer.render(state.tokens, md.options, {}).trimEnd();
  return {
    html: html || undefined,
    mentions: state.mentions,
  };
}
