// Feishu plugin module implements tool result behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { jsonResult as jsonToolResult } from "openclaw/plugin-sdk/tool-results";

export { jsonToolResult };

export function unknownToolActionResult(action: unknown) {
  return jsonToolResult({ error: `Unknown action: ${String(action)}` });
}

export function toolExecutionErrorResult(error: unknown) {
  return jsonToolResult({ error: formatErrorMessage(error) });
}
