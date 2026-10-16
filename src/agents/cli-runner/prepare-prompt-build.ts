// CLI prompt-build hook wiring: context and admitted-request facts for one turn,
// kept beside prepare.ts so the run orchestrator stays within its line budget.
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import type { RunCliAgentParams } from "./types.js";

/** Run-scope facts resolved by the CLI orchestrator before hook dispatch. */
type CliPromptBuildScope = {
  agentId: string;
  workspaceDir: string;
  modelId: string;
};

/** Builds the prompt-build hook context for a CLI turn from its resolved run scope. */
export function buildCliPromptHookContext(
  params: RunCliAgentParams,
  scope: CliPromptBuildScope,
): PluginHookAgentContext {
  return {
    runId: params.runId,
    agentId: scope.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: scope.workspaceDir,
    modelProviderId: params.provider,
    modelId: scope.modelId,
    trigger: params.trigger,
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields(params),
  };
}

/**
 * Resolves the recorder-owned admitted request for this CLI turn.
 *
 * A turn that skipped preparation has no admitted request, so it keeps the
 * legacy identity-free prompt boundary event.
 */
export async function resolveCliCurrentInput(
  params: RunCliAgentParams,
  skipsTurnPreparation: boolean,
) {
  return skipsTurnPreparation
    ? undefined
    : await params.userTurnTranscriptRecorder?.resolveMessage();
}
