import { convertMcpCallToolResult, type ToolResultObject } from "@github/copilot-sdk";
import { sanitizeToolResult } from "openclaw/plugin-sdk/agent-harness-runtime";

type McpToolContent = Parameters<typeof convertMcpCallToolResult>[0]["content"];

/**
 * Redact model-visible text content for Copilot SDK conversion without running
 * the storage-oriented sanitizeToolResult object path that strips image bytes.
 *
 * Copies use object spread so an own `__proto__` JSON key stays data instead of
 * invoking Object.prototype.__proto__ via Object.assign.
 */
export function sanitizeModelVisibleToolContent(content: unknown): McpToolContent {
  if (!Array.isArray(content)) {
    // SAFETY: convertMcpCallToolResult accepts an empty content list for non-array payloads.
    return [] as McpToolContent;
  }
  return content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    // SAFETY: MCP tool content items are untyped JSON; only text/resource.text are redacted.
    const entry = item as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      return { ...entry, text: sanitizeToolResult(entry.text) };
    }
    if (entry.type === "resource" && entry.resource && typeof entry.resource === "object") {
      // SAFETY: resource payloads are untyped JSON; only string resource.text is redacted.
      const resource = entry.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        return {
          ...entry,
          resource: { ...resource, text: sanitizeToolResult(resource.text) },
        };
      }
    }
    return item;
  }) as McpToolContent; // SAFETY: mapped items keep convertMcpCallToolResult's content union after text-only redaction.
}

export function sanitizeModelVisibleSdkToolResult(result: ToolResultObject): ToolResultObject {
  // convertMcpCallToolResult joins text parts before the model sees them, so
  // re-sanitize the joined stream to catch credentials split across adjacent items.
  return {
    ...result,
    textResultForLlm: sanitizeToolResult(result.textResultForLlm),
    ...(typeof result.error === "string" ? { error: sanitizeToolResult(result.error) } : {}),
  };
}

export function createSanitizedFailureResult(
  message: string,
  errorMessage: string,
): ToolResultObject {
  return {
    error: sanitizeToolResult(errorMessage),
    resultType: "failure",
    textResultForLlm: sanitizeToolResult(message),
  };
}
