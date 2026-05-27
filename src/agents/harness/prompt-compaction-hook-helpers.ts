import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";
import { joinPresentTextSegments } from "../../shared/text/join-segments.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";

const log = createSubsystemLogger("agents/harness");

/**
 * Wraps a plugin-emitted system-prompt segment with a stable boundary so the
 * model cannot continue the heading hierarchy of an adjacent block. See
 * issue #87045: without a boundary, an injected `## My Custom Rules` block
 * appended after a workspace-files block was attributed to the last
 * workspace file (e.g. `TOOLS.md`).
 */
const PLUGIN_SYSTEM_CONTEXT_BOUNDARY = "\n---\n[plugin-injected context — not a workspace file]\n";

function wrapPluginSystemContext(segment: string | undefined): string | undefined {
  if (typeof segment !== "string" || segment.trim().length === 0) {
    return undefined;
  }
  return `${PLUGIN_SYSTEM_CONTEXT_BOUNDARY}\n${segment.trim()}\n${PLUGIN_SYSTEM_CONTEXT_BOUNDARY}`;
}

export type AgentHarnessPromptBuildResult = {
  prompt: string;
  developerInstructions: string;
};

export async function resolveAgentHarnessBeforePromptBuildResult(params: {
  prompt: string;
  developerInstructions: string;
  messages: unknown[];
  ctx: AgentHarnessHookContext;
}): Promise<AgentHarnessPromptBuildResult> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_prompt_build") && !hookRunner?.hasHooks("before_agent_start")) {
    return {
      prompt: params.prompt,
      developerInstructions: params.developerInstructions,
    };
  }
  const hookCtx = buildAgentHookContext(params.ctx);
  const promptEvent = {
    prompt: params.prompt,
    messages: params.messages,
  };

  const promptBuildResult = hookRunner.hasHooks("before_prompt_build")
    ? await hookRunner.runBeforePromptBuild(promptEvent, hookCtx).catch((error) => {
        log.warn(`before_prompt_build hook failed: ${String(error)}`);
        return undefined;
      })
    : undefined;
  const legacyResult = hookRunner.hasHooks("before_agent_start")
    ? await hookRunner.runBeforeAgentStart(promptEvent, hookCtx).catch((error) => {
        log.warn(`before_agent_start hook (legacy prompt build path) failed: ${String(error)}`);
        return undefined;
      })
    : undefined;

  const systemPrompt = resolvePromptBuildSystemPrompt({
    developerInstructions: params.developerInstructions,
    promptBuildResult,
    legacyResult,
  });
  return {
    prompt:
      joinPresentTextSegments([
        promptBuildResult?.prependContext,
        legacyResult?.prependContext,
        params.prompt,
      ]) ?? params.prompt,
    developerInstructions:
      joinPresentTextSegments([
        wrapPluginSystemContext(promptBuildResult?.prependSystemContext),
        wrapPluginSystemContext(legacyResult?.prependSystemContext),
        systemPrompt,
        wrapPluginSystemContext(promptBuildResult?.appendSystemContext),
        wrapPluginSystemContext(legacyResult?.appendSystemContext),
      ]) ?? systemPrompt,
  };
}

function resolvePromptBuildSystemPrompt(params: {
  developerInstructions: string;
  promptBuildResult?: PluginHookBeforePromptBuildResult;
  legacyResult?: PluginHookBeforeAgentStartResult;
}): string {
  if (typeof params.promptBuildResult?.systemPrompt === "string") {
    return params.promptBuildResult.systemPrompt;
  }
  if (typeof params.legacyResult?.systemPrompt === "string") {
    return params.legacyResult.systemPrompt;
  }
  return params.developerInstructions;
}

export async function runAgentHarnessBeforeCompactionHook(params: {
  sessionFile: string;
  messages: AgentMessage[];
  ctx: AgentHarnessHookContext;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_compaction")) {
    return;
  }
  try {
    await hookRunner.runBeforeCompaction(
      {
        messageCount: params.messages.length,
        messages: params.messages,
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`before_compaction hook failed: ${String(error)}`);
  }
}

export async function runAgentHarnessAfterCompactionHook(params: {
  sessionFile: string;
  messages: AgentMessage[];
  ctx: AgentHarnessHookContext;
  compactedCount: number;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_compaction")) {
    return;
  }
  try {
    await hookRunner.runAfterCompaction(
      {
        messageCount: params.messages.length,
        compactedCount: params.compactedCount,
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`after_compaction hook failed: ${String(error)}`);
  }
}
