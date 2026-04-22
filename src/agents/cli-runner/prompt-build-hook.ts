import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";
import { joinPresentTextSegments } from "../../shared/text/join-segments.js";
import { cliBackendLog } from "./log.js";

/**
 * Subset of the global hook runner surface this helper needs. Typed
 * structurally so tests can inject a mock without wiring the full runner.
 */
export type CliPromptBuildHookRunner = {
  hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};

/**
 * Invoke the `before_prompt_build` hook (and legacy `before_agent_start` as
 * fallback) so plugins can add context to CLI-backend runs symmetrically
 * with the Pi embedded runner. Merges prepend/append segments, passes
 * `systemPrompt` through as an override, and preserves `prependContext` for
 * the caller to splice into the user prompt.
 *
 * Failures in either hook are warned (not thrown) so a buggy plugin hook
 * can't break the agent run. Returns an empty-shape object when no hooks
 * are registered or all hooks errored.
 */
export async function resolveCliPromptBuildHook(params: {
  prompt: string;
  hookCtx: PluginHookAgentContext;
  hookRunner?: CliPromptBuildHookRunner | null;
}): Promise<PluginHookBeforePromptBuildResult> {
  const runner = params.hookRunner ?? undefined;
  const event = { prompt: params.prompt, messages: [] as unknown[] };

  const promptBuildResult = runner?.hasHooks("before_prompt_build")
    ? await runner.runBeforePromptBuild(event, params.hookCtx).catch((err: unknown) => {
        cliBackendLog.warn(`before_prompt_build hook failed: ${String(err)}`);
        return undefined;
      })
    : undefined;

  // Legacy before_agent_start still fires in parallel (same as pi-embedded
  // runner) so plugins that register only the older hook keep working when
  // a newer plugin also registers before_prompt_build.
  const legacyResult = runner?.hasHooks("before_agent_start")
    ? await runner.runBeforeAgentStart(event, params.hookCtx).catch((err: unknown) => {
        cliBackendLog.warn(
          `before_agent_start hook (legacy prompt build path) failed: ${String(err)}`,
        );
        return undefined;
      })
    : undefined;

  return {
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
    prependContext: joinPresentTextSegments([
      promptBuildResult?.prependContext,
      legacyResult?.prependContext,
    ]),
    prependSystemContext: joinPresentTextSegments([
      promptBuildResult?.prependSystemContext,
      legacyResult?.prependSystemContext,
    ]),
    appendSystemContext: joinPresentTextSegments([
      promptBuildResult?.appendSystemContext,
      legacyResult?.appendSystemContext,
    ]),
  };
}

/** Apply the hook result to a system prompt, honoring overrides + prepend/append. */
export function applyPromptBuildHookToSystemPrompt(params: {
  systemPrompt: string;
  hookResult: PluginHookBeforePromptBuildResult;
}): string {
  const base = params.hookResult.systemPrompt ?? params.systemPrompt;
  const withPrepend = params.hookResult.prependSystemContext
    ? `${params.hookResult.prependSystemContext}\n\n${base}`
    : base;
  return params.hookResult.appendSystemContext
    ? `${withPrepend}\n\n${params.hookResult.appendSystemContext}`
    : withPrepend;
}
