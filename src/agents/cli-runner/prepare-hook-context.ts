import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../plugins/hook-agent-context.types.js";
import type { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { MemoryAudience } from "../../plugins/memory-provider-types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import { buildAgentHookMemoryAudienceFields } from "../harness/hook-context.js";
import { cliBackendLog } from "./log.js";
import { resolveCliMcpMemoryAudience } from "./mcp-memory-audience.js";
import { admitCliRunParams } from "./run-admission.js";
import type { RunCliAgentParams } from "./types.js";

type HookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;

type CliTurnMemoryAudience = {
  memoryAudience?: MemoryAudience;
  /**
   * The audience a loopback grant on `sessionKey` carries: this turn's resolution for
   * its own session, otherwise that session's own resolution, leased by the turn.
   */
  forGrant: (sessionKey: string) => Promise<{ memoryAudience?: MemoryAudience }>;
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
  const resolve = async (sessionKey: string) => {
    // A scheduled run's memory parent exists only on its admitted context. Admission
    // is idempotent, so admitting here leaves the run's later admissions unchanged.
    const admitted = await admitCliRunParams(run, options.agentId);
    const { memoryAudience, release } = await resolveCliMcpMemoryAudience(admitted, {
      agentId: options.agentId,
      sessionKey,
    });
    options.resources.defer(release);
    return { memoryAudience };
  };
  const sessionKey = run.sessionKey;
  const own = options.skip || !sessionKey ? undefined : await resolve(sessionKey);
  return {
    memoryAudience: own?.memoryAudience,
    forGrant: async (grantSessionKey) =>
      own && grantSessionKey === sessionKey ? own : await resolve(grantSessionKey),
  };
}

/**
 * Runs authorized prompt enrichment after the session reuse decision, transcript checks
 * and history selection, reporting what they decided. Failures leave the turn unenriched.
 */
export async function runCliAuthorizedPromptBuild(params: {
  hookRunner: HookRunner | null | undefined;
  admitted: Awaited<ReturnType<typeof admitCliRunParams>>;
  toolAuthorityFingerprint: string | undefined;
  hookCtx: PluginHookAgentContext;
  messages: () => Promise<unknown[]>;
  activeToolNames: readonly string[];
  invalidatedReason?: string;
  nativeSessionId?: string;
  history: { replayed: boolean; gapNotice: boolean };
}) {
  const { hookRunner, toolAuthorityFingerprint, admitted } = params;
  const assertHostActive =
    hookRunner && toolAuthorityFingerprint
      ? resolveAdmittedRunActiveAssertion(admitted.admittedRunContext, admitted.abortSignal)
      : undefined;
  if (!hookRunner || !toolAuthorityFingerprint || !assertHostActive) {
    return undefined;
  }
  const { invalidatedReason } = params;
  try {
    return await hookRunner.runAuthorizedPromptBuild(
      {
        prompt: admitted.prompt,
        messages: await params.messages(),
        continuity: {
          state: invalidatedReason ? "invalidated" : params.nativeSessionId ? "resumed" : "fresh",
          ...(invalidatedReason ? { invalidatedReason } : {}),
          history: params.history.replayed
            ? "included"
            : params.history.gapNotice
              ? "withheld"
              : "none",
        },
      },
      params.hookCtx,
      { toolAuthorityFingerprint, activeToolNames: params.activeToolNames, assertHostActive },
    );
  } catch (error) {
    cliBackendLog.warn(`authorized CLI prompt-build hook failed: ${String(error)}`);
    return undefined;
  }
}
