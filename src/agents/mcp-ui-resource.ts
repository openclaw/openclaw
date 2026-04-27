import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createCanvasDocument, type McpAppViewMeta } from "../gateway/canvas-documents.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export type McpAppCanvasResult = {
  entryUrl: string;
  documentId: string;
  mcpApp: McpAppViewMeta;
  title?: string;
};

export async function fetchMcpAppView(params: {
  runtime: SessionMcpRuntime;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
}): Promise<McpAppCanvasResult | undefined> {
  try {
    const resource = await params.runtime.readResource(params.serverName, params.uiResourceUri);
    const content =
      resource.contents.find((item) => item.uri === params.uiResourceUri) ?? resource.contents[0];
    if (!content) {
      logWarn(
        `mcp-app: empty resource response for ${params.uiResourceUri} from server "${params.serverName}"`,
      );
      return undefined;
    }
    if (content.mimeType !== MCP_APP_RESOURCE_MIME_TYPE) {
      logWarn(
        `mcp-app: unsupported resource mime type ${content.mimeType ?? "<missing>"} for ${params.uiResourceUri} from server "${params.serverName}"`,
      );
      return undefined;
    }
    const html =
      "text" in content && typeof content.text === "string"
        ? content.text
        : "blob" in content && typeof content.blob === "string"
          ? Buffer.from(content.blob, "base64").toString("utf8")
          : undefined;
    if (!html) {
      logWarn(
        `mcp-app: unsupported resource content format for ${params.uiResourceUri} from server "${params.serverName}"`,
      );
      return undefined;
    }

    const mcpApp: McpAppViewMeta = {
      serverName: params.serverName,
      toolName: params.toolName,
      uiResourceUri: params.uiResourceUri,
      ...(params.runtime.sessionKey ? { sessionKey: params.runtime.sessionKey } : {}),
    };

    const manifest = await createCanvasDocument({
      kind: "mcp_app_view",
      title: `${params.toolName} UI`,
      entrypoint: { type: "html", value: html },
      surface: "assistant_message",
      mcpApp,
    });

    return {
      entryUrl: manifest.entryUrl,
      documentId: manifest.id,
      mcpApp,
      title: manifest.title,
    };
  } catch (error) {
    logWarn(
      `mcp-app: failed to fetch UI resource ${params.uiResourceUri} from server "${params.serverName}": ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

export function buildMcpAppCanvasJson(params: {
  view: McpAppCanvasResult;
  toolInput: unknown;
  toolResult: CallToolResult;
}): string {
  const mcpApp = {
    ...params.view.mcpApp,
    toolInput: params.toolInput,
    toolResult: params.toolResult,
  };
  return JSON.stringify({
    kind: "canvas",
    view: {
      url: params.view.entryUrl,
      id: params.view.documentId,
      title: params.view.title,
    },
    presentation: {
      target: "assistant_message",
      title: params.view.title,
      preferred_height: 600,
    },
    mcpApp,
  });
}
