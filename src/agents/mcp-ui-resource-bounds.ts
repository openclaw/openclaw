import type { CallToolResult } from "@modelcontextprotocol/client";

const MCP_APP_VIEW_MAX_BYTES = 6 * 1024 * 1024;

/** Bound display components identically before capture and after transcript selection. */
export function measureMcpAppViewBytes(
  html: string,
  toolInput: unknown,
  toolResult: CallToolResult,
): number {
  const toolData = JSON.stringify({ toolInput, toolResult });
  const byteSize = Buffer.byteLength(html, "utf8") + Buffer.byteLength(toolData, "utf8");
  if (byteSize > MCP_APP_VIEW_MAX_BYTES) {
    throw new Error(`MCP App view data exceeds ${MCP_APP_VIEW_MAX_BYTES} bytes`);
  }
  return byteSize;
}
