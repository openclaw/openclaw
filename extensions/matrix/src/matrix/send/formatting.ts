import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import {
  markdownToMatrixBody,
  markdownToMatrixHtml,
  resolveMatrixMentionsInMarkdown,
  renderMarkdownToMatrixHtmlWithMentions,
  type MatrixMentions,
} from "../format.js";
import type { MatrixClient } from "../sdk.js";
import {
  MsgType,
  type MatrixFormattedContent,
  type MatrixMediaMsgType,
  type MatrixRelation,
  type MatrixTextContent,
  type MatrixTextMsgType,
} from "./types.js";

async function renderMatrixFormattedContent(params: {
  client: MatrixClient;
  markdown?: string | null;
  preparedBody?: string;
  includeMentions?: boolean;
  tableMode?: MarkdownTableMode;
}): Promise<{ body: string; html?: string; mentions?: MatrixMentions }> {
  const markdown = params.markdown ?? "";
  const body = params.preparedBody ?? markdownToMatrixBody(markdown);
  if (params.includeMentions === false) {
    const html = markdownToMatrixHtml(markdown, { tableMode: params.tableMode }).trimEnd();
    return { body, html: html || undefined };
  }
  const { html, mentions } = await renderMarkdownToMatrixHtmlWithMentions({
    markdown,
    client: params.client,
    tableMode: params.tableMode,
  });
  return { body, html, mentions };
}

export function buildTextContent(
  body: string,
  relation?: MatrixRelation,
  opts: {
    msgtype?: MatrixTextMsgType;
  } = {},
): MatrixTextContent {
  return {
    msgtype: opts.msgtype ?? MsgType.Text,
    body,
    ...(relation ? { "m.relates_to": relation } : {}),
  };
}

export async function enrichMatrixFormattedContent(params: {
  client: MatrixClient;
  content: MatrixFormattedContent;
  markdown?: string | null;
  preparedBody?: string;
  includeMentions?: boolean;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { body, html, mentions } = await renderMatrixFormattedContent(params);
  params.content.body = body || params.content.body;
  if (mentions) {
    params.content["m.mentions"] = mentions;
  } else {
    delete params.content["m.mentions"];
  }
  if (!html) {
    delete params.content.format;
    delete params.content.formatted_body;
    return;
  }
  params.content.format = "org.matrix.custom.html";
  params.content.formatted_body = html;
}

export async function resolveMatrixMentionsForBody(params: {
  client: MatrixClient;
  body: string;
}): Promise<MatrixMentions> {
  return await resolveMatrixMentionsInMarkdown({
    markdown: params.body ?? "",
    client: params.client,
  });
}

function normalizeMentionUserIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function extractMatrixMentions(
  content: Record<string, unknown> | undefined,
): MatrixMentions {
  const rawMentions = content?.["m.mentions"];
  if (!rawMentions || typeof rawMentions !== "object") {
    return {};
  }
  const mentions = rawMentions as { room?: unknown; user_ids?: unknown };
  const normalized: MatrixMentions = {};
  const userIds = normalizeMentionUserIds(mentions.user_ids);
  if (userIds.length > 0) {
    normalized.user_ids = userIds;
  }
  if (mentions.room === true) {
    normalized.room = true;
  }
  return normalized;
}

export function diffMatrixMentions(
  current: MatrixMentions,
  previous: MatrixMentions,
): MatrixMentions {
  const previousUserIds = new Set(previous.user_ids ?? []);
  const newUserIds = (current.user_ids ?? []).filter((userId) => !previousUserIds.has(userId));
  const delta: MatrixMentions = {};
  if (newUserIds.length > 0) {
    delta.user_ids = newUserIds;
  }
  if (current.room && !previous.room) {
    delta.room = true;
  }
  return delta;
}

export function resolveMatrixMsgType(contentType?: string): MatrixMediaMsgType {
  const kind = getMatrixRuntime().media.mediaKindFromMime(contentType ?? "");
  switch (kind) {
    case "image":
      return MsgType.Image;
    case "audio":
      return MsgType.Audio;
    case "video":
      return MsgType.Video;
    default:
      return MsgType.File;
  }
}
