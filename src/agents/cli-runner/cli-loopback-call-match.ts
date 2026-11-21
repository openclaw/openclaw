// CLI loopback call matching helpers extracted from execute-tool-tracking.ts to keep
// that module under its line cap. These are pure functions over their inputs.
import { isDeepStrictEqual } from "node:util";
import type { McpLoopbackToolCallStart } from "../../gateway/mcp-http.loopback-runtime.js";
import { stripOpenClawMcpToolPrefix } from "../tool-display-call.js";

export function matchesCliLoopbackCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  call: McpLoopbackToolCallStart,
): boolean {
  return (
    stripOpenClawMcpToolPrefix(toolName) === call.toolName && isDeepStrictEqual(toolArgs, call.args)
  );
}
