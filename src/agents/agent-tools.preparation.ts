import type { createLocalBrowserLoopbackPreparation } from "./agent-tools.execution-policy.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  resolveOpenClawPluginToolsForOptions,
  resolveOpenClawPluginToolsForOptionsAsync,
} from "./openclaw-plugin-tools.js";
import { createOpenClawTools, createOpenClawToolsWithPreparation } from "./openclaw-tools.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { PreparedToolConstruction } from "./tool-construction-preparation.js";

/** The assembly owns order; these adapters satisfy each preparation request. */
export type CodingToolAssembly = Generator<
  | OpenClawToolsOptions
  | {
      prepareBrowserLoopback: NonNullable<ReturnType<typeof createLocalBrowserLoopbackPreparation>>;
    }
  | { pluginTools: Parameters<typeof resolveOpenClawPluginToolsForOptions>[0] },
  AnyAgentTool[],
  AnyAgentTool[]
>;

export function prepareCodingToolAssembly(assembly: CodingToolAssembly): AnyAgentTool[] {
  let step = assembly.next();
  while (!step.done) {
    if ("prepareBrowserLoopback" in step.value) {
      step.value.prepareBrowserLoopback.sync();
      step = assembly.next([]);
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
    const tools =
      "pluginTools" in step.value
        ? await resolveOpenClawPluginToolsForOptionsAsync(step.value.pluginTools)
        : await createOpenClawToolsWithPreparation(step.value, shared);
    shared.assertCurrent();
    step = assembly.next(tools);
  }
  return step.value;
}
