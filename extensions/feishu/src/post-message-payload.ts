// Feishu post-message payload builders.
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { MentionTarget } from "./mention-target.types.js";
import { materializeFeishuPostMarkdownLineBreaks } from "./post-markdown.js";
import type { FeishuSendResult } from "./types.js";

type FeishuPostMessageElement =
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "md"; text: string };

type FeishuPostMessagePayload = {
  content: string;
  msgType: string;
};

function buildFeishuPostMentionElements(mentions?: MentionTarget[]): FeishuPostMessageElement[] {
  if (!mentions?.length) {
    return [];
  }
  const elements: FeishuPostMessageElement[] = [];
  for (const mention of mentions) {
    const userId = mention.openId.trim();
    if (!userId) {
      continue;
    }
    const userName = mention.name.trim();
    elements.push({
      tag: "at",
      user_id: userId,
      ...(userName ? { user_name: userName } : {}),
    });
  }
  return elements;
}

export function prepareFeishuPostMarkdownForChunking(
  cfg: ClawdbotConfig,
  text: string,
  convertTables: typeof convertMarkdownTables = convertMarkdownTables,
): string {
  const tableMode = resolveMarkdownTableMode({ cfg, channel: "feishu" });
  return materializeFeishuPostMarkdownLineBreaks(convertTables(text, tableMode));
}

export function resolveFeishuPostTextChunkLimit(params: {
  account?: { config?: { textChunkLimit?: number } };
  defaultLimit: number;
}): number {
  const limit = params.account?.config?.textChunkLimit;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? limit
    : params.defaultLimit;
}

export function buildFeishuPostMessagePayload(params: {
  messageText: string;
  mentions?: MentionTarget[];
  preparedPostMarkdown?: boolean;
}): FeishuPostMessagePayload {
  return buildFeishuPostMessagePayloadFromText({
    postText: params.preparedPostMarkdown
      ? params.messageText
      : materializeFeishuPostMarkdownLineBreaks(params.messageText),
    mentions: params.mentions,
  });
}

function buildFeishuPostMessagePayloadFromText(params: {
  postText: string;
  mentions?: MentionTarget[];
}): FeishuPostMessagePayload {
  const content: FeishuPostMessageElement[] = [
    ...buildFeishuPostMentionElements(params.mentions),
    { tag: "md", text: params.postText },
  ];
  return {
    content: JSON.stringify({ zh_cn: { content: [content] } }),
    msgType: "post",
  };
}

export function buildFeishuPostMessagePayloads(params: {
  messageText: string;
  mentions?: MentionTarget[];
  maxMarkdownTextLength: number;
  preparedPostMarkdown?: boolean;
}): FeishuPostMessagePayload[] {
  const materializedText = params.preparedPostMarkdown
    ? params.messageText
    : materializeFeishuPostMarkdownLineBreaks(params.messageText);
  const chunks =
    materializedText.length > params.maxMarkdownTextLength
      ? chunkMarkdownTextWithMode(materializedText, params.maxMarkdownTextLength, "length")
      : [materializedText];
  return (chunks.length ? chunks : [""]).map((chunk, index) =>
    buildFeishuPostMessagePayloadFromText({
      postText: chunk,
      mentions: index === 0 ? params.mentions : undefined,
    }),
  );
}

export function buildFeishuPostMessageEditPayload(params: {
  messageText: string;
  maxMarkdownTextLength: number;
}): FeishuPostMessagePayload {
  const materializedText = materializeFeishuPostMarkdownLineBreaks(params.messageText);
  if (materializedText.length > params.maxMarkdownTextLength) {
    throw new Error(
      `Feishu edit text exceeds the Feishu post edit limit (${materializedText.length} > ${params.maxMarkdownTextLength}); send a new message instead.`,
    );
  }
  return buildFeishuPostMessagePayloadFromText({ postText: materializedText });
}

export function combineFeishuSendResults(
  results: readonly FeishuSendResult[],
  chatId: string,
): FeishuSendResult {
  if (results.length === 1 && results[0]) {
    return results[0];
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results,
    kind: "text",
    threadId: chatId,
  });
  return {
    messageId: receipt.primaryPlatformMessageId ?? results[0]?.messageId ?? "unknown",
    chatId,
    receipt,
  };
}
