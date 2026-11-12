import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  bindAgentToolExecutionSchema,
  bindAgentToolListingDefinition,
  getAgentToolAvailabilityBinding,
  resolveAgentToolExecutionSchema,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";

/** Prepare once without changing the policy/schema-eligible definitions. */
export async function prepareAgentToolRuntimeListing(
  tools: AnyAgentTool[],
  assertCurrent: () => void,
): Promise<void> {
  for (const tool of tools) {
    const binding = getAgentToolAvailabilityBinding(tool);
    if (!binding?.prepareListing) {
      continue;
    }
    const definition = await binding.prepareListing();
    assertCurrent();
    if (definition) {
      bindAgentToolListingDefinition(tool, definition);
    }
  }
}

/** Runtime visibility never narrows authority captured for another host. */
export function projectAgentToolRuntimeListing(
  tools: AnyAgentTool[],
  options: {
    /** The current provider owner prepares only definitions changed by listing. */
    normalize?: (tools: AnyAgentTool[]) => AnyAgentTool[];
    onSchemaDiagnostics?: (
      diagnostics: readonly RuntimeToolSchemaDiagnostic[],
      tools: AnyAgentTool[],
    ) => void;
  } = {},
): AnyAgentTool[] {
  const supported = tools.filter((tool) => getPluginToolMeta(tool)?.listingSupported !== false);
  return supported.flatMap((tool) => {
    const definition = getAgentToolAvailabilityBinding(tool)?.listingDefinition;
    if (!definition) {
      return [tool];
    }
    const projected = copyAgentToolMetadata(tool, { ...tool, ...definition });
    // A listing schema is never the local argument-validation contract. Consume
    // its one-shot override so later projections cannot restore the raw schema.
    bindAgentToolExecutionSchema(projected, resolveAgentToolExecutionSchema(tool, tool.parameters));
    bindAgentToolListingDefinition(projected, undefined);
    // Prepare each replacement in its source slot: catalog entries may share a
    // name while retaining different owners and executors.
    const normalized = options.normalize?.([projected]) ?? [projected];
    const projection = filterRuntimeCompatibleTools(normalized);
    if (options.onSchemaDiagnostics) {
      options.onSchemaDiagnostics(projection.diagnostics, normalized);
    } else {
      for (const diagnostic of projection.diagnostics) {
        logWarn(
          `Unsupported listing schema for ${diagnostic.toolName}: ${diagnostic.violations.join(", ")}`,
        );
      }
    }
    return projection.tools;
  });
}
