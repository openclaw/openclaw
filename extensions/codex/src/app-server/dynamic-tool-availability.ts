import {
  finalizeAgentToolAvailability,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { fingerprintCodexPolicy } from "./config-policy-json.js";
import {
  projectCodexDynamicTools,
  type CodexDynamicToolSchemaQuarantine,
  type ProjectedCodexDynamicTool,
} from "./dynamic-tool-catalog.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

/** Prepare the actual executable set, then reproject only changed owner definitions. */
export function finalizeCodexToolAvailability(
  entries: readonly ProjectedCodexDynamicTool<AnyAgentTool>[],
  acceptedSpecs?: readonly CodexDynamicToolSpec[],
) {
  const accepted = acceptedSpecs
    ? new Map(flattenCodexDynamicToolFunctions(acceptedSpecs).map((tool) => [tool.name, tool]))
    : undefined;
  let candidates = entries;
  const preparedNames = new Set<string>();
  const quarantinedTools: CodexDynamicToolSchemaQuarantine[] = [];
  for (;;) {
    const snapshots = candidates.map((entry) => ({
      entry,
      parameters: entry.tool.parameters,
      description: entry.tool.description,
    }));
    finalizeAgentToolAvailability(
      candidates.map((entry) => entry.tool),
      { onPrepared: (tool) => preparedNames.add(tool.name) },
    );
    const tools: ProjectedCodexDynamicTool<AnyAgentTool>[] = [];
    for (const { entry, parameters, description } of snapshots) {
      if (
        !preparedNames.has(entry.name) &&
        entry.tool.parameters === parameters &&
        entry.tool.description === description
      ) {
        tools.push(entry);
        continue;
      }
      const projected = projectCodexDynamicTools([entry.tool]);
      tools.push(...projected.tools);
      quarantinedTools.push(...projected.quarantinedTools);
    }
    if (!accepted) {
      return { tools, quarantinedTools, preparedNames };
    }
    const matching = tools.filter((entry) => {
      const declaration = accepted.get(entry.name);
      return (
        declaration !== undefined &&
        fingerprintCodexPolicy({
          description: entry.description,
          inputSchema: entry.inputSchema,
        }) ===
          fingerprintCodexPolicy({
            description: declaration.description,
            inputSchema: declaration.inputSchema,
          })
      );
    });
    if (matching.length === candidates.length || matching.length === 0) {
      return { tools: matching, quarantinedTools, preparedNames };
    }
    // Rejected dependencies cannot keep a surviving executor's affordances.
    // Each repeat removes at least one candidate, so preparation is bounded.
    candidates = matching;
  }
}
