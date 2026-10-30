import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { isToolResultError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import type { ImageContent, TextContent } from "openclaw/plugin-sdk/llm";
import {
  estimateToolResultTextChars,
  sliceToolResultTextToBudget,
} from "openclaw/plugin-sdk/text-utility-runtime";
import { failedToolResult } from "./dynamic-tool-response-state.js";
import { invalidInlineImageText } from "./image-payload-sanitizer.js";
import type { CodexDynamicToolCallOutputContentItem } from "./protocol.js";

export function enforceWholeSkillResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  maxChars: number,
): AgentToolResult<unknown> {
  if (toolName !== "skills_read" || isToolResultError(result)) {
    return result;
  }
  const budget = result.content.reduce(
    (total, item) => total + (item.type === "text" ? estimateToolResultTextChars(item.text) : 0),
    0,
  );
  return budget <= maxChars
    ? result
    : failedToolResult(
        `This Codex turn cannot deliver the whole skill within its ${maxChars}-character weighted output budget. No instructions were returned; use a harness with a larger instruction budget.`,
      );
}

export function convertToolContents(
  rawContent: Array<TextContent | ImageContent>,
  maxChars: number,
): CodexDynamicToolCallOutputContentItem[] {
  const content = rawContent;
  const totalTextChars = content.reduce(
    (total, item) => total + (item.type === "text" ? item.text.length : 0),
    0,
  );
  const totalTextBudget = content.reduce(
    (total, item) => total + (item.type === "text" ? estimateToolResultTextChars(item.text) : 0),
    0,
  );
  if (totalTextBudget <= maxChars) {
    return content.map(convertToolContent);
  }
  const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalTextChars} chars, weighted budget ${maxChars}; rerun with narrower args.)`;
  const notice = `\n${noticeText}`;
  const noticeChars = estimateToolResultTextChars(notice);
  const textBudget = Math.max(0, maxChars - noticeChars);
  let remainingTextBudget = textBudget;
  let appendedNotice = false;
  const output: CodexDynamicToolCallOutputContentItem[] = [];
  for (const item of content) {
    if (item.type !== "text") {
      output.push(convertToolContent(item));
      continue;
    }
    if (appendedNotice) {
      continue;
    }
    if (noticeChars >= maxChars) {
      output.push({ type: "inputText", text: sliceToolResultTextToBudget(noticeText, maxChars) });
      appendedNotice = true;
      continue;
    }
    const text = sliceToolResultTextToBudget(item.text, remainingTextBudget);
    remainingTextBudget -= estimateToolResultTextChars(text);
    const shouldAppendNotice = remainingTextBudget <= 0 || text.length < item.text.length;
    if (shouldAppendNotice) {
      // The notice budget is reserved before slicing text, so the combined
      // result is already bounded without another boundary-sensitive cut.
      output.push({ type: "inputText", text: `${text.trimEnd()}${notice}` });
      appendedNotice = true;
    } else if (text.length > 0) {
      output.push({ type: "inputText", text });
    }
  }
  if (!appendedNotice) {
    output.push({ type: "inputText", text: sliceToolResultTextToBudget(noticeText, maxChars) });
  }
  return output;
}
function convertToolContent(
  content: TextContent | ImageContent,
): CodexDynamicToolCallOutputContentItem {
  if (content.type === "text") {
    return { type: "inputText", text: content.text };
  }
  const imageUrl = sanitizeInlineImageDataUrl(`data:${content.mimeType};base64,${content.data}`);
  return imageUrl
    ? { type: "inputImage", imageUrl }
    : { type: "inputText", text: invalidInlineImageText("codex dynamic tool") };
}
