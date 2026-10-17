import type { ClientCapabilities, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeModelSpecialTokens } from "../security/external-content.js";

const MCP_METADATA_TEXT_LIMIT = 1_200;
const OPENCLAW_PROMPT_MARKER_OPENER = /<!--(?=\s*\/?\s*openclaw[\s:_-])/gi;
const MCP_APPS_CLIENT_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export function buildMcpClientCapabilities(mcpAppsEnabled: boolean): ClientCapabilities {
  return mcpAppsEnabled
    ? {
        elicitation: { form: {}, url: {} },
        extensions: {
          "openai/elicitation": { form: {} },
          [MCP_APPS_CLIENT_EXTENSION]: { mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE] },
        },
      }
    : {};
}

export function normalizeToolUiVisibility(value: unknown): Array<"app" | "model"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(
    (entry): entry is "app" | "model" => entry === "app" || entry === "model",
  );
  return [...new Set(normalized)].toSorted();
}

export function summarizeServerCapabilities(capabilities: ServerCapabilities | undefined) {
  return {
    resources: capabilities?.resources
      ? { listChanged: capabilities.resources.listChanged === true }
      : undefined,
    prompts: capabilities?.prompts
      ? { listChanged: capabilities.prompts.listChanged === true }
      : undefined,
    tools: capabilities?.tools
      ? { listChanged: capabilities.tools.listChanged === true }
      : undefined,
  };
}

function scrubMcpMetadataText(value: unknown, limit?: number): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const scrubbed = normalized
    .replace(
      /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(/system\s+prompt/gi, "system prompt")
    // Server text must not open or close OpenClaw prompt sections (attempt regions, cache boundary).
    .replace(OPENCLAW_PROMPT_MARKER_OPENER, "<! --");
  const sanitized = sanitizeModelSpecialTokens(scrubbed);
  return limit !== undefined && sanitized.length > limit
    ? `${truncateUtf16Safe(sanitized, limit)}...`
    : sanitized;
}

/** Scrubs untrusted MCP metadata before exposing it to a model. */
export function sanitizeMcpMetadataText(value: string | undefined): string | undefined {
  return scrubMcpMetadataText(value, MCP_METADATA_TEXT_LIMIT);
}

/**
 * Scrubs a server's initialize instructions. They stay whole: a rule at the end
 * (quota, confirmation) is as binding as the first line.
 */
export function sanitizeMcpServerInstructions(value: unknown): string | undefined {
  return scrubMcpMetadataText(value);
}
