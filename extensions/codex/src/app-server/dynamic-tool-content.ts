import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { isToolResultError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import type { ImageContent, TextContent } from "openclaw/plugin-sdk/llm";
import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  estimateToolResultTextChars,
  resolveLiveToolResultMaxChars,
  sliceToolResultTextToBudget,
} from "openclaw/plugin-sdk/text-utility-runtime";
import { failedToolResult } from "./dynamic-tool-response-state.js";
import { invalidInlineImageText } from "./image-payload-sanitizer.js";
import type { CodexDynamicToolCallOutputContentItem } from "./protocol.js";

/**
 * Skill Library pins live in the Gateway state directory, which a remote app-server's
 * own file tools cannot open; copies already delivered under its workspace root stay.
 */
export function resolveGatewayOnlySkillDirs(
  skills: readonly { name: string; source: string; filePath: string }[],
  remoteWorkspaceRoot: string | undefined,
): Map<string, string> {
  const root = `${remoteWorkspaceRoot?.replace(/\/+$/u, "")}/`;
  const remote = skills.filter(
    (skill) =>
      remoteWorkspaceRoot &&
      skill.source === "openclaw-library" &&
      !skill.filePath.startsWith(root),
  );
  return new Map(remote.map((skill) => [skill.name, path.dirname(skill.filePath)]));
}

/** One bridge's weighted output budget and its skill-result presentation. */
export function createCodexToolResultPresentation(
  context:
    | { contextWindowTokens?: number; gatewayOnlySkillDirs?: ReadonlyMap<string, string> }
    | undefined,
) {
  const contextWindowTokens = context?.contextWindowTokens;
  const maxChars =
    contextWindowTokens !== undefined && contextWindowTokens > 0
      ? Math.max(1, resolveLiveToolResultMaxChars({ contextWindowTokens }))
      : DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  const presentSkillResult = async (toolName: string, result: AgentToolResult<unknown>) =>
    enforceWholeSkillResult(
      toolName,
      await withoutGatewayOnlySkillLocation(toolName, result, context?.gatewayOnlySkillDirs),
      maxChars,
      result,
    );
  return { maxChars, presentSkillResult };
}

/** Results for Gateway-only skills name no path that the remote reader would try to open. */
async function withoutGatewayOnlySkillLocation(
  toolName: string,
  result: AgentToolResult<unknown>,
  gatewayOnly: ReadonlyMap<string, string> | undefined,
): Promise<AgentToolResult<unknown>> {
  const details = asOptionalRecord(result.details);
  if (!gatewayOnly?.size || !details || isToolResultError(result)) {
    return result;
  }
  // Only the recorded Gateway copy: a same-named skill the remote machine can open keeps its path.
  const gatewayOnlyLocation = (entry: Record<string, unknown> | undefined) => {
    const location = readStringField(entry, "location");
    const dir = gatewayOnly.get(readStringField(entry, "name") ?? "");
    return location && dir && path.dirname(location) === dir ? location : undefined;
  };
  if (toolName === "skills_search" && Array.isArray(details.skills)) {
    const skills = details.skills.map((hit: unknown) => {
      const entry = asOptionalRecord(hit);
      return gatewayOnlyLocation(entry) ? { ...entry, location: undefined } : hit;
    });
    return { ...result, content: [{ type: "text", text: JSON.stringify({ ...details, skills }) }] };
  }
  const location = gatewayOnlyLocation(details);
  const header = `Skill location: ${location}\nResolve relative resource paths from the directory containing this SKILL.md.\n`;
  const [item] = result.content;
  if (
    toolName !== "skills_read" ||
    !location ||
    item?.type !== "text" ||
    !item.text.startsWith(header)
  ) {
    return result;
  }
  const rest = item.text.slice(header.length);
  const files = await fs.readdir(path.dirname(location)).catch(() => []);
  const text = files.some((file) => file !== "SKILL.md")
    ? `Its supporting files are stored on the Gateway and cannot be opened from this machine.\n${rest}`
    : rest.replace(/^\n/u, "");
  return { ...result, content: [{ type: "text", text }] };
}

function enforceWholeSkillResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  maxChars: number,
  originalResult: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  if (toolName !== "skills_read" || isToolResultError(result)) {
    return result;
  }
  const budget = result.content.reduce(
    (total, item) => total + (item.type === "text" ? estimateToolResultTextChars(item.text) : 0),
    0,
  );
  const details = asOptionalRecord(originalResult.details);
  const instructions = readStringField(details, "content");
  const [item] = originalResult.content;
  // Generic skill reads can paginate; compare the original body before location redaction.
  // Already-delivered notices have no named instruction record.
  const incomplete =
    readStringField(details, "name") !== undefined &&
    readStringField(details, "location") !== undefined &&
    instructions !== undefined &&
    (item?.type !== "text" || !item.text.endsWith(instructions));
  return !incomplete && budget <= maxChars
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
