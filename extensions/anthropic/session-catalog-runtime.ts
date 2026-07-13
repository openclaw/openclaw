import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

export function boundClaudeThreadId(
  pluginId: string,
  entry: {
    cliSessionBindings?: unknown;
    pluginOwnerId?: string;
    modelSelectionLocked?: boolean;
    pluginExtensions?: unknown;
  },
): string | undefined {
  const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
  const binding = bindings?.[CLAUDE_CLI_BACKEND_ID];
  if (isRecord(binding) && typeof binding.sessionId === "string") {
    return binding.sessionId;
  }
  if (entry.pluginOwnerId !== pluginId || entry.modelSelectionLocked !== true) {
    return undefined;
  }
  const anthropic = isRecord(entry.pluginExtensions) ? entry.pluginExtensions.anthropic : undefined;
  const marker = isRecord(anthropic) ? anthropic.sessionCatalog : undefined;
  return isRecord(marker) && typeof marker.sourceThreadId === "string"
    ? marker.sourceThreadId
    : undefined;
}
