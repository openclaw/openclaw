import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createMcpStructuredContentMirrorMatcher } from "./mcp-structured-mirror.js";
import type { AgentToolResult } from "./runtime/index.js";
import { isToolResultError } from "./tool-result-error.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";

type McpAgentContentBlock = AgentToolResult<unknown>["content"][number];

// Guest values stay private; snapshots move ownership until the bridge consumes them.
const mcpCodeModeGuestResults = new WeakMap<AgentToolResult<unknown>, unknown>();

export function setMcpCodeModeGuestResult(
  result: AgentToolResult<unknown>,
  value: unknown,
): AgentToolResult<unknown> {
  mcpCodeModeGuestResults.set(result, value);
  return result;
}

export function setMcpCodeModeGuestResultFromAgentResult(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  return setMcpCodeModeGuestResult(result, {
    content: result.content,
    isError: isToolResultError(result),
  });
}

export function transferMcpCodeModeGuestResult(
  source: AgentToolResult<unknown>,
  target: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  if (mcpCodeModeGuestResults.has(source)) {
    mcpCodeModeGuestResults.set(target, mcpCodeModeGuestResults.get(source));
    mcpCodeModeGuestResults.delete(source);
  }
  return target;
}

export function consumeMcpCodeModeGuestResult(result: AgentToolResult<unknown>): unknown {
  const value = mcpCodeModeGuestResults.get(result);
  if (!mcpCodeModeGuestResults.delete(result)) {
    return undefined;
  }
  const safe = toToolSearchJsonSafe(value);
  if (isRecord(safe)) {
    delete safe._meta;
  }
  return safe;
}

function stringifyMcpContent(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Converts untrusted MCP content into the agent text/image contract. */
function mcpContentBlockToAgentContent(block: unknown): McpAgentContentBlock {
  if (!isRecord(block)) {
    return { type: "text", text: stringifyMcpContent(block) };
  }
  switch (block.type) {
    case "text":
      if (typeof block.text === "string") {
        return { type: "text", text: block.text };
      }
      break;
    case "image":
      if (typeof block.data === "string" && typeof block.mimeType === "string") {
        return { type: "image", data: block.data, mimeType: block.mimeType };
      }
      break;
    case "audio":
      if (typeof block.mimeType === "string") {
        return { type: "text", text: `[audio ${block.mimeType}]` };
      }
      break;
    case "resource_link": {
      if (typeof block.uri !== "string") {
        break;
      }
      const label =
        typeof block.title === "string"
          ? block.title
          : typeof block.name === "string"
            ? block.name
            : undefined;
      return { type: "text", text: label ? `[${label}] ${block.uri}` : block.uri };
    }
    case "resource": {
      if (!isRecord(block.resource) || typeof block.resource.uri !== "string") {
        break;
      }
      const text = typeof block.resource.text === "string" ? block.resource.text : undefined;
      return { type: "text", text: text ?? block.resource.uri };
    }
  }
  return { type: "text", text: stringifyMcpContent(block) };
}

function projectMcpCallToolResultContent(result: {
  content?: unknown;
  structuredContent?: unknown;
}): { content: AgentToolResult<unknown>["content"]; unprojectable?: true } {
  const sourceContent = Array.isArray(result.content) ? result.content : [];
  if (isRecord(result.structuredContent)) {
    try {
      const isStructuredMirror = createMcpStructuredContentMirrorMatcher(result.structuredContent);
      const structuredJson = JSON.stringify(
        JSON.parse(stableStringify(result.structuredContent)),
        null,
        2,
      );
      const structuredText = `structuredContent:\n${structuredJson}`;
      return {
        content: [
          { type: "text", text: structuredText },
          ...sourceContent
            // Only a full JSON mirror of structuredContent is redundant; overlapping text can carry recovery guidance.
            .filter(
              (block) =>
                !isRecord(block) ||
                block.type !== "text" ||
                typeof block.text !== "string" ||
                !isStructuredMirror(block.text),
            )
            .map(mcpContentBlockToAgentContent),
        ],
      };
    } catch (error) {
      // A remote MCP server controls this value. Serializing it recurses per field,
      // so a deeply nested result would otherwise surface as an uncaught RangeError
      // on the model boundary; degrade to a handled failure instead.
      if (!(error instanceof RangeError)) {
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: "structuredContent was too deeply nested to project. Ask the MCP server for a flatter result or query a specific field.",
          },
          ...sourceContent.map(mcpContentBlockToAgentContent),
        ],
        unprojectable: true,
      };
    }
  }
  return { content: sourceContent.map(mcpContentBlockToAgentContent) };
}

/** Projects a raw MCP CallToolResult exactly once at the model boundary. */
export function projectMcpCallToolResult(
  result: { content?: unknown; structuredContent?: unknown; isError?: unknown },
  details: Record<string, unknown> = {},
): AgentToolResult<unknown> {
  const projectedContent = projectMcpCallToolResultContent(result);
  const unprojectable = projectedContent.unprojectable === true;
  const isError = result.isError === true || unprojectable;
  const content = projectedContent.content;
  const projected: AgentToolResult<unknown> = {
    content:
      content.length > 0
        ? content
        : [
            {
              type: "text",
              text: isError
                ? "MCP tool failed without returning content."
                : "MCP tool completed without returning content.",
            },
          ],
    details: {
      ...details,
      // A value too deep to project is also too deep for downstream recursive
      // digests (loop detection reads these details), so it is not retained.
      ...(result.structuredContent !== undefined && !unprojectable
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(isError ? { status: "error" } : {}),
    },
  };
  return setMcpCodeModeGuestResult(projected, {
    // Guest callers read this snapshot instead of the model-facing result, so an
    // unprojectable value is a failure for them too and carries the same notice.
    content: unprojectable
      ? projected.content
      : Array.isArray(result.content)
        ? result.content
        : [],
    ...(result.structuredContent !== undefined && !unprojectable
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(typeof result.isError === "boolean" || unprojectable ? { isError } : {}),
  });
}

/** Keep template roles descriptive while projecting its content for the model. */
export function projectMcpGetPromptResult(
  result: GetPromptResult,
  details: Record<string, unknown>,
): AgentToolResult<unknown> {
  const content = result.messages.flatMap(({ role, content: block }) => [
    { type: "text", text: `${role}:` },
    block,
  ]);
  if (result.description !== undefined) {
    content.unshift({ type: "text", text: result.description });
  }
  return setMcpCodeModeGuestResult(
    projectMcpCallToolResult({ content }, details),
    toToolSearchJsonSafe(result),
  );
}
