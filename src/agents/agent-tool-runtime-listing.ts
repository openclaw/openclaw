import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  bindAgentToolListingDefinition,
  getAgentToolAvailabilityBinding,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

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
export function projectAgentToolRuntimeListing(tools: AnyAgentTool[]): AnyAgentTool[] {
  return tools.flatMap((tool) => {
    if (getPluginToolMeta(tool)?.listingSupported === false) {
      return [];
    }
    const definition = getAgentToolAvailabilityBinding(tool)?.listingDefinition;
    return [definition ? copyAgentToolMetadata(tool, { ...tool, ...definition }) : tool];
  });
}
