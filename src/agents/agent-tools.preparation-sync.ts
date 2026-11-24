import type { CodingToolAssembly } from "./agent-tools.preparation.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

export function prepareCodingToolAssembly(assembly: CodingToolAssembly): AnyAgentTool[] {
  let step = assembly.next();
  while (!step.done) {
    if ("prepareBrowserLoopback" in step.value) {
      step.value.prepareBrowserLoopback.sync();
      step = assembly.next([]);
      continue;
    }
    if ("coreTools" in step.value) {
      step = assembly.next(createCoreCodingTools(step.value.coreTools));
      continue;
    }
    if ("channelTools" in step.value) {
      step = assembly.next(listChannelAgentTools(step.value.channelTools));
      continue;
    }
    step = assembly.next(
      "pluginTools" in step.value
        ? resolveOpenClawPluginToolsForOptions(step.value.pluginTools)
        : createOpenClawTools(step.value),
    );
  }
  return step.value;
}
