import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { isToolResultError, sanitizeToolResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import type { ImageContent, TextContent } from "openclaw/plugin-sdk/llm";
import {
  estimateToolResultTextChars,
  sliceToolResultTextToBudget,
  sliceUtf16Safe,
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
  const budget = sanitizeToolTextRuns(result.content).reduce(
    (total, item) => total + (item.type === "text" ? estimateToolResultTextChars(item.text) : 0),
    0,
  );
  return budget <= maxChars
    ? result
    : failedToolResult(
        `This Codex turn cannot deliver the whole skill within its ${maxChars}-character weighted output budget. No instructions were returned; use a harness with a larger instruction budget.`,
      );
}

function sanitizeToolTextRuns(
  rawContent: Array<TextContent | ImageContent>,
): Array<TextContent | ImageContent> {
  const content: Array<TextContent | ImageContent> = [];
  for (let index = 0; index < rawContent.length;) {
    const item = rawContent[index]!;
    if (item.type !== "text") {
      content.push(item);
      index += 1;
      continue;
    }

    const textRun: TextContent[] = [];
    while (index < rawContent.length) {
      const next = rawContent[index]!;
      if (next.type !== "text") {
        break;
      }
      textRun.push(next);
      index += 1;
    }

    const sanitizedText = sanitizeToolResult(textRun.map((entry) => entry.text).join(""));
    let offset = 0;
    content.push(
      ...textRun.map((entry, runIndex) => {
        const targetEnd =
          runIndex === textRun.length - 1
            ? sanitizedText.length
            : Math.min(sanitizedText.length, offset + entry.text.length);
        const text = sliceUtf16Safe(sanitizedText, offset, targetEnd);
        const sanitized = Object.assign({}, entry, { text });
        offset += text.length;
        return sanitized;
      }),
    );
  }
  return content;
}
export function convertToolContents(
  rawContent: Array<TextContent | ImageContent>,
  maxChars: number,
): CodexDynamicToolCallOutputContentItem[] {
  // Adjacent text items form one model-visible stream, so sanitize each full run before
  // repartitioning and budgeting. Image blocks keep their bytes; the storage-oriented
  // whole-result branch of sanitizeToolResult would drop them.
  const content = sanitizeToolTextRuns(rawContent);
  const totalTextChars = content.reduce(
    (total, item) => total + (item.type === "text" ? item.text.length : 0),
    0,
  );
  const totalTextBudget = content.reduce(
    (total, item) => total + (item.type === "text" ? estimateToolResultTextChars(item.text) : 0),
    0,
  );
  if (totalTextBudget <= maxChars) {
    return content.flatMap(convertToolContent);
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
      output.push(...convertToolContent(item));
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
): CodexDynamicToolCallOutputContentItem[] {
  if (content.type === "text") {
    return [{ type: "inputText", text: content.text }];
  }
  const imageUrl = sanitizeInlineImageDataUrl(`data:${content.mimeType};base64,${content.data}`);
  if (!imageUrl) {
    return [{ type: "inputText", text: invalidInlineImageText("codex dynamic tool") }];
  }
  return [
    {
      type: "inputImage",
      imageUrl,
    },
  ];
}
