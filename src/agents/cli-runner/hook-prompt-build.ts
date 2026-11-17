import type { OpenClawConfig } from "../../config/types.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  resolvePromptBuildHookResult,
  type ResolvedPromptBuildHookResult,
} from "../embedded-agent-runner/run/attempt-prompt-helpers.js";
import { cliBackendLog } from "./log.js";

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
}): Promise<ResolvedPromptBuildHookResult | undefined> {
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
