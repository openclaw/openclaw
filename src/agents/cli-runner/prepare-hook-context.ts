import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import type { MemoryAudience } from "../../plugins/memory-provider-types.js";
import { buildAgentHookMemoryAudienceFields } from "../harness/hook-context.js";
import { resolveCliMcpMemoryAudience } from "./mcp-memory-audience.js";
import { admitCliRunParams } from "./run-admission.js";
import type { RunCliAgentParams } from "./types.js";

type CliTurnMemoryAudience = {
  memoryAudience?: MemoryAudience;
  /** This turn's resolution for a grant on its own session; other sessions resolve their own. */
  forGrant: (sessionKey: string | undefined) => { memoryAudience?: MemoryAudience } | undefined;
};

/**
 * Resolve one CLI turn's host-minted memory audience once, for its hooks and its
 * loopback grant, as on embedded turns, and build its prompt-build hook context.
 * `resources` owns the audience's session leases: it is disposed when preparation
 * fails and moved into run cleanup when it succeeds.
 */
export async function prepareCliTurnHookContext(
  run: RunCliAgentParams,
  facts: {
    agentId: string;
    workspaceDir: string;
    modelId: string;
    contextTokenBudget: number;
    skip: boolean;
    resources: DisposableStack;
  },
) {
  const turnAudience = await resolveCliTurnMemoryAudience(run, facts);
  return {
    turnAudience,
    promptBuildHookContext: {
      runId: run.runId,
      agentId: facts.agentId,
      sessionKey: run.sessionKey,
      sessionId: run.sessionId,
      workspaceDir: facts.workspaceDir,
      modelProviderId: run.provider,
      modelId: facts.modelId,
      contextTokenBudget: facts.contextTokenBudget,
      trigger: run.trigger,
      inputProvenance: run.inputProvenance,
      ...buildAgentHookMemoryAudienceFields(turnAudience.memoryAudience, run.sessionKey),
      ...buildAgentHookContextChannelFields(run),
    },
  };
}

async function resolveCliTurnMemoryAudience(
  run: RunCliAgentParams,
  options: { agentId: string; skip: boolean; resources: DisposableStack },
): Promise<CliTurnMemoryAudience> {
  const sessionKey = run.sessionKey;
  if (options.skip || !sessionKey) {
    return { forGrant: () => undefined };
  }
  // A scheduled run's memory parent exists only on its admitted context. Admission
  // is idempotent, so admitting here leaves the run's later admissions unchanged.
  const admitted = await admitCliRunParams(run, options.agentId);
  const { memoryAudience, release } = await resolveCliMcpMemoryAudience(admitted, {
    agentId: options.agentId,
    sessionKey,
  });
  options.resources.defer(release);
  return {
    memoryAudience,
    forGrant: (grantSessionKey) =>
      grantSessionKey === sessionKey ? { memoryAudience } : undefined,
  };
}
