import type { OpenClawConfig } from "../../config/types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/hook-types.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { buildPromptBuildDropResult } from "../../plugins/prompt-build-drop.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import { resolvePromptBuildHookResult } from "../embedded-agent-runner/run/attempt-prompt-helpers.js";
import { cliBackendLog } from "./log.js";
import type { RunCliAgentParams } from "./types.js";

type AdmittedCliRunParams = RunCliAgentParams & {
  admittedRunContext: NonNullable<RunCliAgentParams["admittedRunContext"]>;
};

/**
 * Ordinary before_prompt_build phase for a CLI run. History is loaded lazily so a
 * skipped turn never pays for it.
 */
export async function resolveCliPromptBuildHookResult(params: {
  skipsTurnPreparation: boolean;
  config: OpenClawConfig;
  prompt: string;
  loadMessages: () => Promise<unknown[]>;
  hookCtx: PluginHookAgentContext;
  hookRunner: HookRunner | null | undefined;
  bootstrapContextRunKind: RunCliAgentParams["bootstrapContextRunKind"];
}): Promise<PluginHookBeforePromptBuildResult | undefined> {
  if (params.skipsTurnPreparation) {
    return undefined;
  }
  try {
    return await resolvePromptBuildHookResult({
      config: params.config,
      prompt: params.prompt,
      messages: await params.loadMessages(),
      hookCtx: params.hookCtx,
      hookRunner: params.hookRunner,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
    });
  } catch (error) {
    // Deliberately marker-free: this catch also spans pre-dispatch preparation
    // (config resolution, session-history load, hook-context assembly), so a
    // failure here does not prove a plugin contribution was ever dispatched or
    // dropped. Telling the model that context is missing when it never existed
    // is the same misleading-recovery-instruction failure the marker exists to
    // prevent. A real before_prompt_build rejection is turned into the bounded
    // drop marker at the dispatch boundary inside resolvePromptBuildHookResult
    // (openclaw-beads-201); the operator diagnostic stays in the warn above.
    cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
    return undefined;
  }
}

/**
 * Authorized before_prompt_build phase, dispatched only once the host has
 * finalized the turn's tool surface. Admission may replace the prepared params,
 * so the caller adopts the returned ones.
 */
export async function resolveAuthorizedCliPromptBuildHookResult(input: {
  params: RunCliAgentParams;
  admitParams: (candidate: RunCliAgentParams) => Promise<AdmittedCliRunParams>;
  hookRunner: HookRunner | null | undefined;
  hookCtx: PluginHookAgentContext;
  loadMessages: () => Promise<unknown[]>;
  activeToolNames: readonly string[];
}): Promise<{
  params: RunCliAgentParams;
  result: PluginHookBeforePromptBuildResult | undefined;
}> {
  const toolAuthorityFingerprint = input.params.toolAuthorityFingerprint;
  const hookRunner = input.hookRunner;
  if (!hookRunner || !toolAuthorityFingerprint) {
    return { params: input.params, result: undefined };
  }
  const params = await input.admitParams(input.params);
  const assertHostActive = resolveAdmittedRunActiveAssertion(
    params.admittedRunContext,
    params.abortSignal,
  );
  if (!assertHostActive) {
    return { params, result: undefined };
  }
  // Preparation gets its own catch, matching the ordinary phase above: a
  // session-history load never reaches the dispatcher, so reporting it as a
  // dropped contribution would hand the model a false recovery instruction.
  let promptEvent: { prompt: string; messages: unknown[] };
  try {
    promptEvent = { prompt: params.prompt, messages: await input.loadMessages() };
  } catch (error) {
    cliBackendLog.warn(`authorized cli prompt-build hook preparation failed: ${String(error)}`);
    return { params, result: undefined };
  }
  try {
    const result = await hookRunner.runAuthorizedPromptBuild(promptEvent, input.hookCtx, {
      toolAuthorityFingerprint,
      activeToolNames: input.activeToolNames,
      assertHostActive,
    });
    return { params, result };
  } catch (error) {
    cliBackendLog.warn(`authorized CLI prompt-build hook failed: ${String(error)}`);
    // This prepared run continues, so the lost contribution has to be visible
    // in the prompt it continues with. A rejection here is dispatch-level and
    // never reaches runAuthorizedPromptBuild's per-handler drop collector.
    return { params, result: buildPromptBuildDropResult([{ reason: "dispatch-failed" }]) };
  }
}
