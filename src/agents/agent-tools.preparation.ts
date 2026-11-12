import type { createLocalBrowserLoopbackPreparation } from "./agent-tools.execution-policy.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { listChannelAgentTools } from "./channel-tools.js";
import type { createCoreCodingTools } from "./core-coding-tools.js";
import type { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { PreparedToolConstruction } from "./tool-construction-preparation.js";

/** The assembly owns order; these adapters satisfy each preparation request. */
export type CodingToolAssembly = Generator<
  | OpenClawToolsOptions
  | { coreTools: Parameters<typeof createCoreCodingTools>[0] }
  | { channelTools: Parameters<typeof listChannelAgentTools>[0] }
  | {
      prepareBrowserLoopback: NonNullable<ReturnType<typeof createLocalBrowserLoopbackPreparation>>;
    }
  | { pluginTools: Parameters<typeof resolveOpenClawPluginToolsForOptions>[0] },
  AnyAgentTool[],
  AnyAgentTool[]
>;

export async function prepareCodingToolAssemblyAsync(
  assembly: CodingToolAssembly,
  shared: PreparedToolConstruction,
): Promise<AnyAgentTool[]> {
  let step = assembly.next();
  while (!step.done) {
    if ("prepareBrowserLoopback" in step.value) {
      await step.value.prepareBrowserLoopback.prepare(shared);
      step = assembly.next([]);
      continue;
    }
    let tools: AnyAgentTool[];
    if ("coreTools" in step.value) {
      const { createCoreCodingTools } = await import("./core-coding-tools.js");
      shared.assertCurrent();
      tools = createCoreCodingTools(step.value.coreTools);
    } else if ("channelTools" in step.value) {
      const { listChannelAgentTools } = await import("./channel-tools.js");
      shared.assertCurrent();
      tools = listChannelAgentTools(step.value.channelTools);
    } else if ("pluginTools" in step.value) {
      const { resolveOpenClawPluginToolsForOptionsAsync } =
        await import("./openclaw-plugin-tools.js");
      shared.assertCurrent();
      tools = await resolveOpenClawPluginToolsForOptionsAsync(step.value.pluginTools);
    } else {
      const { createOpenClawToolsWithPreparation } = await import("./openclaw-tools.js");
      shared.assertCurrent();
      tools = await createOpenClawToolsWithPreparation(step.value, shared);
    }
    shared.assertCurrent();
    step = assembly.next(tools);
  }
  return step.value;
}
