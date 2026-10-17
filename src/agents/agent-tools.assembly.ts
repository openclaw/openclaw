import { normalizeToolParameterSchema } from "@openclaw/ai/internal/tool-schema";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { getCoreToolDeclaration, type CoreToolDeclaration } from "./agent-tool-metadata.js";
import { describeAvailableTool } from "./agent-tools.deferred-followup.js";
import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";
import { applyModelProviderToolPolicy } from "./agent-tools.model-provider-policy.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isToolAllowedByDelegationCapability } from "./delegation-capability.js";
import {
  resolveOpenClawPluginToolsForOptions,
  resolveOpenClawPluginToolsForOptionsAsync,
} from "./openclaw-plugin-tools.js";
import { createOpenClawTools, createOpenClawToolsWithPreparation } from "./openclaw-tools.js";
import { applySwarmCollectorToolContract } from "./openclaw-tools.swarm.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { withLegacySessionCapabilityRead } from "./subagents/spawn/subagent-session-store-legacy.js";
import type { PreparedToolConstruction } from "./tool-construction-preparation.js";

export type CodingToolAssembly = Generator<
  | OpenClawToolsOptions
  | { pluginTools: Parameters<typeof resolveOpenClawPluginToolsForOptions>[0] },
  AnyAgentTool[],
  AnyAgentTool[]
>;

/** The legacy driver consumes the same assembly as asynchronous construction. */
export function finishCodingToolAssembly(assembly: CodingToolAssembly): AnyAgentTool[] {
  return withLegacySessionCapabilityRead(() => {
    let step = assembly.next();
    while (!step.done) {
      step = assembly.next(
        "pluginTools" in step.value
          ? resolveOpenClawPluginToolsForOptions(step.value.pluginTools)
          : createOpenClawTools(step.value),
      );
    }
    return step.value;
  });
}

export async function finishCodingToolAssemblyAsync(
  assembly: CodingToolAssembly,
  shared: PreparedToolConstruction,
  conditionalCoreDeclarations: CoreToolDeclaration[],
): Promise<AnyAgentTool[]> {
  let step = assembly.next();
  while (!step.done) {
    const tools =
      "pluginTools" in step.value
        ? await resolveOpenClawPluginToolsForOptionsAsync(step.value.pluginTools)
        : await createOpenClawToolsWithPreparation(step.value, shared, (declaration) => {
            conditionalCoreDeclarations.push(declaration);
          });
    shared.assertCurrent();
    step = assembly.next(tools);
  }
  return step.value;
}

/** Reuse availability owners for literals omitted by transient construction. */
export function selectConditionalCoreDeclarations(
  declarations: CoreToolDeclaration[],
  constructed: AnyAgentTool[],
  options: Parameters<typeof applyModelProviderToolPolicy>[1] & { messageProvider?: string },
) {
  // Never replace constructed plugin/prepared/ring-zero tools, including ones
  // later removed by availability. No name-based core classification occurs here.
  return applyModelProviderToolPolicy(
    filterToolsByMessageProvider(
      declarations.filter(
        (declaration) => !constructed.some((tool) => tool.name === declaration.name),
      ),
      options.messageProvider,
    ),
    options,
  );
}

/** Project only producer-identified literals; never bind or return executors. */
export function projectCoreToolDeclarations(
  sources: CoreToolDeclaration[],
  authorizedTools: AnyAgentTool[],
  options?: InternalCodingToolsOptions,
) {
  const selected = applySwarmCollectorToolContract(
    sources.filter((tool) =>
      isToolAllowedByDelegationCapability(tool.name, options?.delegationCapability),
    ),
    { swarmCollector: options?.swarmCollector },
  );
  const availableNames = new Set([...authorizedTools, ...selected].map((tool) => tool.name));
  finalizeAgentToolAvailability(selected, { beforeNormalization: true });
  return selected
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((tool) => {
      const declaration = getCoreToolDeclaration(tool);
      return declaration
        ? [
            {
              name: declaration.name,
              ...(declaration.catalogMode ? { catalogMode: declaration.catalogMode } : {}),
              description: describeAvailableTool(declaration, availableNames),
              parameters: normalizeToolParameterSchema(declaration.parameters, {
                modelProvider: options?.modelProvider,
                modelId: options?.modelId,
                modelCompat: options?.modelCompat,
                toolName: declaration.name,
              }),
            },
          ]
        : [];
    });
}
