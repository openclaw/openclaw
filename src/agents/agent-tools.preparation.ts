import { isEmbeddedMode } from "../infra/embedded-mode.js";
import type { createLocalBrowserLoopbackPreparation } from "./agent-tools.execution-policy.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { loadPairedComputerUseAvailabilityForSurface } from "./computer-use-node-capabilities.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import {
  resolveOpenClawPluginToolsForOptions,
  resolveOpenClawPluginToolsForOptionsAsync,
} from "./openclaw-plugin-tools.js";
import { resolveSessionToolListingClientCaps } from "./openclaw-tools.client-caps.js";
import { createOpenClawTools, createOpenClawToolsWithPreparation } from "./openclaw-tools.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveSessionPlacementComputer } from "./session-placement-computer.js";
import { withPreparedSessionCapabilityRead } from "./subagents/spawn/subagent-session-store.js";
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

/** Prepare policy and listing facts before either harness serializes its tool surface. */
export async function prepareCodingToolOptions(
  options: InternalCodingToolsOptions | undefined,
  shared: PreparedToolConstruction,
  signal?: AbortSignal,
) {
  const conversationCapabilityProfile =
    options?.conversationCapabilityProfile ??
    (await prepareConversationCapabilityProfile({
      ...options,
      config: shared.config,
      agentId: options?.policyAgentId ?? options?.agentId,
      sandboxToolPolicy: options?.sandbox?.enabled ? options.sandbox.tools : undefined,
      pluginMetadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
    }));
  const computerTransport =
    options?.computerTransport !== undefined
      ? options.computerTransport
      : resolveSessionPlacementComputer(options?.operationalRunInstance);
  const pairedNodeComputerUse =
    options?.pairedNodeComputerUse ??
    (
      await loadPairedComputerUseAvailabilityForSurface({
        computerAllowed:
          options?.includeCoreTools !== false &&
          options?.toolConstructionPlan?.includeOpenClawTools !== false &&
          isConversationToolAllowed(conversationCapabilityProfile, "computer") &&
          applyEmbeddedAttemptToolsAllow([{ name: "computer" }], options?.runtimeToolAllowlist)
            .length === 1,
        modelHasVision: options?.modelHasVision,
        computerTransport,
        embeddedMode: isEmbeddedMode(),
        signal,
      })
    )?.prepared;
  shared.assertCurrent();
  const listingClientCaps =
    options?.listingClientCaps ??
    (await withPreparedSessionCapabilityRead(() =>
      resolveSessionToolListingClientCaps({ ...options, config: shared.config }),
    ));
  return {
    ...options,
    config: shared.config,
    conversationCapabilityProfile,
    listingClientCaps,
    computerTransport,
    pairedNodeComputerUse,
  };
}
