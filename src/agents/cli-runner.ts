import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { executeWithOverflowProtection } from "./cli-runner/execute.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { applySkillEnvOverridesFromSnapshot } from "./skills.js";

export async function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult> {
  const context = await prepareCliRunContext(params);
  const restoreSkillEnv =
    params.disableTools !== true
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: context.effectiveSkillsSnapshot,
          config: params.config,
        })
      : () => {};

  // Try with the provided CLI session ID first
  try {
    try {
      const result = await executeWithOverflowProtection(
        context,
        context.reusableCliSession.sessionId,
      );
      const effectiveCliSessionId =
        result.cliSessionBinding?.sessionId ??
        result.output.sessionId ??
        context.reusableCliSession.sessionId;
      const text = result.output.text?.trim();
      const payloads = text ? [{ text }] : undefined;

      return {
        payloads,
        meta: {
          durationMs: Date.now() - context.started,
          systemPromptReport: result.systemPromptReport,
          agentMeta: {
            sessionId: effectiveCliSessionId ?? params.sessionId ?? "",
            provider: params.provider,
            model: context.modelId,
            usage: result.output.usage,
            ...(result.compactionsThisRun > 0
              ? { compactionCount: result.compactionsThisRun }
              : {}),
            ...(effectiveCliSessionId
              ? {
                  cliSessionBinding: {
                    sessionId: effectiveCliSessionId,
                    ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
                    ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                    ...(context.extraSystemPromptHash
                      ? { extraSystemPromptHash: context.extraSystemPromptHash }
                      : {}),
                    ...(context.preparedBackend.mcpConfigHash
                      ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                      : {}),
                    ...(result.cliSessionBinding?.systemPromptFile
                      ? {
                          systemPromptFile: result.cliSessionBinding.systemPromptFile,
                          systemPromptHash: result.cliSessionBinding.systemPromptHash,
                          systemPromptCompactionCount:
                            result.cliSessionBinding.systemPromptCompactionCount,
                        }
                      : {}),
                    ...(result.cliSessionBinding?.semanticSessionFile
                      ? {
                          semanticContextFiles: result.cliSessionBinding.semanticContextFiles,
                          semanticSessionFile: result.cliSessionBinding.semanticSessionFile,
                          semanticSessionHash: result.cliSessionBinding.semanticSessionHash,
                          semanticCompactionCount: result.cliSessionBinding.semanticCompactionCount,
                        }
                      : {}),
                  },
                }
              : {}),
            ...(result.cliPromptLoad ? { cliPromptLoad: result.cliPromptLoad } : {}),
          },
        },
      };
    } catch (err) {
      if (err instanceof FailoverError) {
        // Check if this is a session expired error and we have a session to clear
        if (
          err.reason === "session_expired" &&
          context.reusableCliSession.sessionId &&
          params.sessionKey
        ) {
          // Retry without the session ID to create a new session
          const result = await executeWithOverflowProtection(context, undefined);
          const effectiveCliSessionId =
            result.cliSessionBinding?.sessionId ?? result.output.sessionId;
          const text = result.output.text?.trim();
          const payloads = text ? [{ text }] : undefined;

          return {
            payloads,
            meta: {
              durationMs: Date.now() - context.started,
              systemPromptReport: result.systemPromptReport,
              agentMeta: {
                sessionId: effectiveCliSessionId ?? params.sessionId ?? "",
                provider: params.provider,
                model: context.modelId,
                usage: result.output.usage,
                ...(result.compactionsThisRun > 0
                  ? { compactionCount: result.compactionsThisRun }
                  : {}),
                ...(effectiveCliSessionId
                  ? {
                      cliSessionBinding: {
                        sessionId: effectiveCliSessionId,
                        ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
                        ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                        ...(context.extraSystemPromptHash
                          ? { extraSystemPromptHash: context.extraSystemPromptHash }
                          : {}),
                        ...(context.preparedBackend.mcpConfigHash
                          ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                          : {}),
                        ...(result.cliSessionBinding?.systemPromptFile
                          ? {
                              systemPromptFile: result.cliSessionBinding.systemPromptFile,
                              systemPromptHash: result.cliSessionBinding.systemPromptHash,
                              systemPromptCompactionCount:
                                result.cliSessionBinding.systemPromptCompactionCount,
                            }
                          : {}),
                        ...(result.cliSessionBinding?.semanticSessionFile
                          ? {
                              semanticContextFiles: result.cliSessionBinding.semanticContextFiles,
                              semanticSessionFile: result.cliSessionBinding.semanticSessionFile,
                              semanticSessionHash: result.cliSessionBinding.semanticSessionHash,
                              semanticCompactionCount:
                                result.cliSessionBinding.semanticCompactionCount,
                            }
                          : {}),
                      },
                    }
                  : {}),
                ...(result.cliPromptLoad ? { cliPromptLoad: result.cliPromptLoad } : {}),
              },
            },
          };
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
    restoreSkillEnv();
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
