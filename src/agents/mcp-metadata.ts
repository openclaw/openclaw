import type { ClientCapabilities, ServerCapabilities, Tool } from "@modelcontextprotocol/client";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { McpCatalogTool } from "./agent-bundle-mcp-catalog.types.js";

const MCP_METADATA_TEXT_LIMIT = 1_200;
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

function normalizeToolUiVisibility(value: unknown): Array<"app" | "model"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(
    (entry): entry is "app" | "model" => entry === "app" || entry === "model",
  );
  return [...new Set(normalized)].toSorted();
}

export function readMcpToolUiMetadata(
  tool: Tool,
): Pick<McpCatalogTool, "uiVisibility" | "uiResourceUri"> {
  const ui = asOptionalRecord(tool._meta?.ui);
  const uri = ui?.resourceUri ?? tool._meta?.["ui/resourceUri"];
  const uiVisibility = normalizeToolUiVisibility(ui?.visibility);
  return {
    ...(typeof uri === "string" && uri.startsWith("ui://") ? { uiResourceUri: uri } : {}),
    ...(uiVisibility ? { uiVisibility } : {}),
  };
}

export function isAppOnlyMcpTool({ uiVisibility }: Pick<McpCatalogTool, "uiVisibility">): boolean {
  return uiVisibility !== undefined && !uiVisibility.includes("model");
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

/** Scrubs untrusted MCP metadata before exposing it to a model. */
export function sanitizeMcpMetadataText(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const scrubbed = normalized
    .replace(
      /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(/system\s+prompt/gi, "system prompt");
  return scrubbed.length > MCP_METADATA_TEXT_LIMIT
    ? `${truncateUtf16Safe(scrubbed, MCP_METADATA_TEXT_LIMIT)}...`
    : scrubbed;
}
