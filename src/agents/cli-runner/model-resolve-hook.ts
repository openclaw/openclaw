import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
/**
 * CLI-side emission of the before_model_resolve hook.
 *
 * The embedded runner resolves hook model overrides inside its model setup; the CLI
 * dispatch path returns before that setup, so CLI-backed turns never emit the hook and
 * plugins cannot route those turns. This module owns the CLI-side emission, mirroring
 * the embedded semantics (once per turn, before the model is normalized for the child).
 *
 * Only overrides that resolve back to the already selected CLI backend can be honored:
 * the child process is spawned through the caller-selected backend, so a cross-runtime
 * override would silently change the transport instead of the model. Cross-runtime
 * overrides preserve the caller's selection and say so in the log.
 */
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { resolveHookModelSelection } from "../embedded-agent-runner/run/setup.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import type { RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

export type CliModelResolveHookInput = {
  hookRunner: Pick<HookRunner, "hasHooks" | "runBeforeModelResolve"> | null;
  prompt: string;
  /** Execution backend this turn spawns through, e.g. `claude-cli`. */
  executionProvider: string;
  /** Logical provider of the caller-selected model, e.g. `anthropic`. */
  logicalProvider: string;
  modelId: string;
  sessionEntry?: SessionEntry;
  config?: OpenClawConfig;
  agentId?: string;
  runId?: string;
  jobId?: string;
  sessionKey?: string;
  sessionId: string;
  workspaceDir: string;
  trigger?: string;
  channelId?: string;
  accountId?: string;
  messageProvider?: string;
};

export type CliModelResolveHookOutcome = {
  /** Provider and model the CLI child must run with after hook resolution. */
  provider: string;
  modelId: string;
  /** True when the hook overrode the caller's model within the same backend. */
  applied: boolean;
  /** Set when the hook asked for an override the CLI path could not honor. */
  rejectedOverride?: { provider: string; modelId: string };
};

export async function resolveCliModelOverrideForTurn(
  params: CliModelResolveHookInput,
): Promise<CliModelResolveHookOutcome> {
  const original: CliModelResolveHookOutcome = {
    provider: params.executionProvider,
    modelId: params.modelId,
    applied: false,
  };
  if (!params.hookRunner?.hasHooks("before_model_resolve")) {
    return original;
  }
  const hookSelection = await resolveHookModelSelection({
    prompt: params.prompt,
    provider: params.logicalProvider,
    modelId: params.modelId,
    modelSelectionLocked: params.sessionEntry?.modelSelectionLocked === true,
    hookRunner: params.hookRunner,
    // The logical provider is reported, not the execution backend: routers compare
    // the current logical selection against e.g. `anthropic/<model>`, and would
    // otherwise treat `claude-cli/<model>` as an existing manual override.
    hookContext: {
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.jobId ? { jobId: params.jobId } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      modelProviderId: params.logicalProvider,
      messageProvider: params.messageProvider,
      trigger: params.trigger,
      channelId: params.channelId,
    },
  });
  if (hookSelection.modelId === params.modelId) {
    return original;
  }
  // A provider override that leaves the logical provider cannot run through this
  // backend. An override within the same logical provider still has to resolve its
  // own CLI runtime to the backend this turn already selected.
  const overrideResolvesToSelectedBackend =
    hookSelection.provider === params.logicalProvider &&
    resolveCliRuntimeExecutionProvider({
      provider: hookSelection.provider,
      cfg: params.config,
      agentId: params.agentId,
      modelId: hookSelection.modelId,
    }) === params.executionProvider;
  if (!overrideResolvesToSelectedBackend) {
    return {
      ...original,
      rejectedOverride: { provider: hookSelection.provider, modelId: hookSelection.modelId },
    };
  }
  return {
    provider: params.executionProvider,
    modelId: hookSelection.modelId,
    applied: true,
  };
}

/**
 * Emits before_model_resolve for one CLI-backed turn and returns the model id the
 * child must run with, or undefined when the caller's selection stands. Callers
 * must keep this before CLI preparation, which normalizes the model for the child.
 */
export async function runCliModelResolveHookForTurn(
  params: CliModelResolveHookInput,
): Promise<string | undefined> {
  const outcome = await resolveCliModelOverrideForTurn(params);
  if (outcome.applied) {
    log.info(
      `before_model_resolve override applied on cli path: provider=${sanitizeForLog(params.logicalProvider)} model=${sanitizeForLog(outcome.modelId)}`,
    );
    return outcome.modelId;
  }
  if (outcome.rejectedOverride) {
    log.warn(
      `before_model_resolve override to ${sanitizeForLog(outcome.rejectedOverride.provider)}/${sanitizeForLog(outcome.rejectedOverride.modelId)} skipped: cli path only honors overrides resolving to the selected backend ${sanitizeForLog(params.executionProvider)}`,
    );
  }
  return undefined;
}

/**
 * Runs the CLI-side hook for one top-level turn and folds any same-backend override
 * into the run's model before CLI preparation normalizes it for the child process.
 * Synthetic turns (isolated completions, backend control operations) never enter
 * agent hooks and keep the caller's selection.
 */
export async function applyCliModelResolveHookForRun(params: RunCliAgentParams): Promise<void> {
  if (params.isolatedCompletion || params.controlOperation) {
    return;
  }
  const hookModelId = await runCliModelResolveHookForTurn({
    hookRunner: getGlobalHookRunner(),
    prompt: params.prompt,
    executionProvider: params.provider,
    logicalProvider: params.modelProvider ?? params.provider,
    modelId: params.model ?? "",
    sessionEntry: params.sessionEntry,
    config: params.config,
    agentId: params.agentId,
    runId: params.runId,
    jobId: params.jobId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    trigger: params.trigger,
    messageProvider: params.messageProvider,
  });
  if (hookModelId !== undefined) {
    params.model = hookModelId;
    if (params.requesterModel) {
      params.requesterModel = { ...params.requesterModel, model: hookModelId };
    }
  }
}
