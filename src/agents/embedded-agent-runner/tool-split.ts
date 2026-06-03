import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import type { HookContext } from "../agent-tools.before-tool-call.js";
import type { AgentTool } from "../runtime/index.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

/**
 * Converts OpenClaw-managed tools into SDK custom tool definitions for both
 * sandboxed and non-sandboxed sessions.
 */
export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  toolHookContext?: HookContext;
}): {
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools, toolHookContext } = options;
  // `sandboxEnabled` stays in the call contract because callers decide policy
  // before this boundary; splitting here would bypass OpenClaw's hook pipeline.
  return {
    customTools: toToolDefinitions(tools, toolHookContext),
  };
}
