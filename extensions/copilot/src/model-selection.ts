import type { SessionConfig } from "@github/copilot-sdk";
import { buildAgentRuntimePlan } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CopilotModelProviderInput } from "./provider-bridge.js";

type ModelSelectionContext = Pick<
  Parameters<typeof buildAgentRuntimePlan>[0],
  "config" | "agentId" | "agentDir" | "workspaceDir"
> & { runtimePlan?: ReturnType<typeof buildAgentRuntimePlan> };

export function resolveCopilotSessionModel(
  model: Pick<CopilotModelProviderInput, "id" | "provider" | "params">,
  context: ModelSelectionContext,
): Pick<SessionConfig, "model" | "capi"> {
  if (
    model.provider.trim().toLowerCase() !== "github-copilot" ||
    model.id.toLowerCase() !== "fusion"
  ) {
    return { model: model.id };
  }
  const runtimePlan =
    context.runtimePlan ??
    buildAgentRuntimePlan({
      config: context.config,
      agentId: context.agentId,
      agentDir: context.agentDir,
      workspaceDir: context.workspaceDir,
      provider: model.provider,
      modelId: model.id,
      model,
      harnessId: "copilot",
    });
  const fusionTier =
    runtimePlan.transport.resolveExtraParams().fusionTier ?? model.params?.fusionTier ?? "standard";
  if (fusionTier !== "standard" && fusionTier !== "high" && fusionTier !== "max") {
    throw new Error('[copilot] fusionTier must be "standard", "high", or "max"');
  }
  // Fusion effort is a routing tier, separate from the selected model's reasoning effort.
  return { model: "fusion", capi: { fusionTier } };
}
