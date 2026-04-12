import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { resolvePromptBuildHookResult } from "./pi-embedded-runner/run/attempt.prompt-helpers.js";
import { describeUnknownError } from "./pi-embedded-runner/utils.js";

export async function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult> {
  const context = await prepareCliRunContext(params);

  // Dispatch before_prompt_build hooks (same as pi-embedded runner)
  // This allows memory plugins to inject prompt context before CLI execution.
  const hookRunner = getGlobalHookRunner();
  const hookCtx = {
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
  };
  const hookResult = await resolvePromptBuildHookResult({
    prompt: params.prompt,
    messages: [],
    hookCtx,
    hookRunner: hookRunner ?? undefined,
  });
  if (hookResult?.prependContext) {
    context.params.prompt = `${hookResult.prependContext}\n\n${context.params.prompt}`;
  }
  if (hookResult?.systemPrompt) {
    // CLI runner does not use system prompts in the same way as pi-embedded,
    // but we apply it to the context system prompt for consistency.
    context.systemPrompt = hookResult.systemPrompt;
  }

  const buildCliRunResult = (resultParams: {
    output: Awaited<ReturnType<typeof executePreparedCliRun>>;
    effectiveCliSessionId?: string;
  }): EmbeddedPiRunResult => {
    const text = resultParams.output.text?.trim();
    const payloads = text ? [{ text }] : undefined;

    return {
      payloads,
      meta: {
        durationMs: Date.now() - context.started,
        systemPromptReport: context.systemPromptReport,
        agentMeta: {
          sessionId: resultParams.effectiveCliSessionId ?? params.sessionId ?? "",
          provider: params.provider,
          model: context.modelId,
          usage: resultParams.output.usage,
          ...(resultParams.effectiveCliSessionId
            ? {
                cliSessionBinding: {
                  sessionId: resultParams.effectiveCliSessionId,
                  ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
                  ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                  ...(context.extraSystemPromptHash
                    ? { extraSystemPromptHash: context.extraSystemPromptHash }
                    : {}),
                  ...(context.preparedBackend.mcpConfigHash
                    ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                    : {}),
                },
              }
            : {}),
        },
      },
    };
  };

  // Try with the provided CLI session ID first
  let success = false;
  let runError: unknown = null;
  let output: Awaited<ReturnType<typeof executePreparedCliRun>> | undefined;
  try {
    try {
      output = await executePreparedCliRun(context, context.reusableCliSession.sessionId);
      const effectiveCliSessionId = output.sessionId ?? context.reusableCliSession.sessionId;
      success = true;
      return buildCliRunResult({ output, effectiveCliSessionId });
    } catch (err) {
      runError = err;
      if (err instanceof FailoverError) {
        // Check if this is a session expired error and we have a session to clear
        if (
          err.reason === "session_expired" &&
          context.reusableCliSession.sessionId &&
          params.sessionKey
        ) {
          // Clear the expired session ID from the session entry
          // This requires access to the session store, which we don't have here
          // We'll need to modify the caller to handle this case

          // For now, retry without the session ID to create a new session
          runError = null;
          output = await executePreparedCliRun(context, undefined);
          const effectiveCliSessionId = output.sessionId;
          success = true;
          return buildCliRunResult({ output, effectiveCliSessionId });
        }
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isFailoverErrorMessage(message, { provider: params.provider })) {
        const reason = classifyFailoverReason(message, { provider: params.provider }) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(message, {
          reason,
          provider: params.provider,
          model: context.modelId,
          status,
        });
      }
      throw err;
    }
  } finally {
    // Dispatch agent_end hooks (same as pi-embedded runner)
    // This allows memory plugins to analyze completed conversations.
    if (hookRunner?.hasHooks("agent_end")) {
      const text = output?.text?.trim();
      const messages: unknown[] = [
        { role: "user", content: params.prompt },
        ...(text ? [{ role: "assistant", content: text }] : []),
      ];
      hookRunner
        .runAgentEnd(
          {
            messages,
            success,
            error: runError ? describeUnknownError(runError) : undefined,
            durationMs: Date.now() - context.started,
          },
          hookCtx,
        )
        .catch((err: unknown) => {
          // fire-and-forget; log failures but don't propagate
          console.warn(`agent_end hook failed: ${String(err)}`);
        });
    }
    await context.preparedBackend.cleanup?.();
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
  });
}
