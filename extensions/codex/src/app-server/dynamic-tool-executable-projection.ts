import {
  isToolWrappedWithBeforeToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
  type AnyAgentTool,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectCodexDynamicTools,
  type CodexDynamicToolSchemaQuarantine,
  type ProjectedCodexDynamicTool,
} from "./dynamic-tool-catalog.js";
import type { CodexDynamicToolHookContext } from "./dynamic-tools.js";

export function projectCodexExecutableDynamicToolSurface(
  tools: readonly AnyAgentTool[],
  hookContext: CodexDynamicToolHookContext | undefined,
): {
  tools: ProjectedCodexDynamicTool<AnyAgentTool>[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const { tools: projectedTools, quarantinedTools } = projectCodexDynamicTools(tools);
  const wrappedTools: ProjectedCodexDynamicTool<AnyAgentTool>[] = [];
  for (const entry of projectedTools) {
    try {
      if (isToolWrappedWithBeforeToolCallHook(entry.tool)) {
        setBeforeToolCallDiagnosticsEnabled(entry.tool, false);
        wrappedTools.push(entry);
        continue;
      }
      wrappedTools.push({
        ...entry,
        tool: wrapToolWithBeforeToolCallHook(entry.tool, hookContext, { emitDiagnostics: false }),
      });
    } catch {
      quarantinedTools.push({
        tool: entry.name,
        violations: [`${entry.name} could not be wrapped for before-tool-call hooks`],
      });
    }
  }
  return {
    tools: wrappedTools,
    quarantinedTools: [...new Map(quarantinedTools.map((tool) => [tool.tool, tool])).values()],
  };
}
