import { isDeepStrictEqual } from "node:util";
import {
  finalizeAgentToolAvailability,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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
    ? new Map(flattenCodexDynamicToolFunctions(acceptedSpecs).map((spec) => [spec.name, spec]))
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
        declaration?.description === entry.description &&
        isDeepStrictEqual(declaration.inputSchema, entry.inputSchema)
      );
    });
    if (matching.length === candidates.length || matching.length === 0) {
      return { tools: matching, quarantinedTools, preparedNames };
    }
    // Removing an incompatible executor can change a dependent owner's contract.
    // Reprepare only the surviving cohort; every retry removes at least one tool.
    candidates = matching;
  }
}
