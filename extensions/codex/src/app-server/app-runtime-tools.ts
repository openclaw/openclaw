import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexMcpToolConnectorId } from "./mcp-tool-metadata.js";
import { isJsonObject } from "./protocol.js";

const CODEX_APPS_MCP_SERVER = "codex_apps";
const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;

export type CodexAppRuntimeTool = {
  actionName?: string;
  readOnlyHint?: boolean;
  title?: string;
  linkId?: string;
  requiresExplicitLinkId?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

export async function readCodexAppRuntimeTools(params: {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  threadId?: string;
}): Promise<Map<string, Map<string, CodexAppRuntimeTool>>> {
  const toolsByApp = new Map<string, Map<string, CodexAppRuntimeTool>>();
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
    const response = await params.request("mcpServerStatus/list", {
      ...(params.threadId ? { threadId: params.threadId } : {}),
      serverName: CODEX_APPS_MCP_SERVER,
      detail: "toolsAndAuthOnly",
      limit: MCP_STATUS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!isJsonObject(response) || !Array.isArray(response.data)) {
      throw new Error("Codex mcpServerStatus/list returned invalid app tool inventory");
    }
    for (const status of response.data) {
      if (!isJsonObject(status) || !isJsonObject(status.tools)) {
        throw new Error("Codex app tool inventory contained an invalid server status");
      }
      if (status.name !== CODEX_APPS_MCP_SERVER) {
        continue;
      }
      for (const [toolName, tool] of Object.entries(status.tools)) {
        const connectorId = readCodexMcpToolConnectorId(tool);
        if (connectorId) {
          const tools = toolsByApp.get(connectorId) ?? new Map<string, CodexAppRuntimeTool>();
          const metadata = asOptionalRecord(tool);
          const appMetadata = asOptionalRecord(metadata?._meta);
          const annotations = asOptionalRecord(metadata?.annotations);
          const hosted = asOptionalRecord(appMetadata?.["_codex_apps"]);
          const resource =
            typeof hosted?.resource_uri === "string" ? hosted.resource_uri.split("/") : [];
          tools.set(toolName, {
            // The hosted service binds the action to /<connector>/<link or store>/<action>.
            // Display names and tool titles are not stable action identifiers.
            actionName:
              resource.length === 4 &&
              resource[0] === "" &&
              resource[1] === connectorId &&
              resource[2] &&
              hosted?.synthetic_link !== true
                ? resource[3]
                : undefined,
            readOnlyHint: annotations?.readOnlyHint === true,
            title: typeof metadata?.title === "string" ? metadata.title : undefined,
            linkId:
              typeof appMetadata?.link_id === "string" && appMetadata.link_id.trim()
                ? appMetadata.link_id
                : undefined,
            requiresExplicitLinkId: hosted?.requires_explicit_link_id === true,
            destructiveHint: annotations?.destructiveHint === false ? false : undefined,
            openWorldHint: annotations?.openWorldHint === false ? false : undefined,
          });
          toolsByApp.set(connectorId, tools);
        }
      }
    }
    if (
      response.nextCursor !== undefined &&
      response.nextCursor !== null &&
      typeof response.nextCursor !== "string"
    ) {
      throw new Error("Codex app tool inventory returned an invalid pagination cursor");
    }
    cursor = response.nextCursor;
    if (!cursor) {
      return toolsByApp;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Codex app connector inventory repeated its pagination cursor");
    }
    seenCursors.add(cursor);
  }
  throw new Error("Codex app connector inventory exceeded its bounded page limit");
}
