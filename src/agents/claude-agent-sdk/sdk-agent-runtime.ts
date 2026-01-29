/**
 * Claude Agent SDK runtime implementation.
 *
 * Implements the AgentRuntime interface using the Claude Agent SDK for execution.
 * Uses both shared generalized fields and CCSDK-specific options from ccsdkOptions bag.
 */

import type { MoltbotConfig } from "../../config/config.js";
import type { AgentRuntime, AgentRuntimeRunParams, AgentRuntimeResult } from "../agent-runtime.js";
import type { AgentCcSdkConfig } from "../../config/types.agents.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { SdkReasoningLevel, SdkVerboseLevel } from "./types.js";
import type { AnyAgentTool } from "../tools/common.js";
import { runSdkAgent } from "./sdk-runner.js";
import { resolveProviderConfig } from "./provider-config.js";
import { isSdkAvailable } from "./sdk-loader.js";
import { loadSessionHistoryForSdk } from "./sdk-session-history.js";
import {
  appendSdkTurnPairToSessionTranscript,
  appendSdkToolCallsToSessionTranscript,
} from "./sdk-session-transcript.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SdkConversationTurn, SdkRunnerResult } from "./types.js";
import { createMoltbotCodingTools } from "../pi-tools.js";
import { resolveMoltbotAgentDir } from "../agent-paths.js";
import { resolveModelAuthMode } from "../model-auth.js";
import { convertClientToolsForSdk } from "./client-tool-bridge.js";

const log = createSubsystemLogger("agents/ccsdk-runtime");

export type CcSdkAgentRuntimeContext = {
  /** Moltbot configuration. */
  config?: MoltbotConfig;
  /** Claude Code SDK configuration. */
  ccsdkConfig?: AgentCcSdkConfig;
  /** Explicit API key override. */
  apiKey?: string;
  /** Explicit auth token override (for subscription auth). */
  authToken?: string;
  /** Custom base URL for API requests. */
  baseUrl?: string;
  /** Pre-built tools to expose to the agent. */
  tools?: AnyAgentTool[];
  /** Pre-loaded conversation history (if not loading from session file). */
  conversationHistory?: SdkConversationTurn[];
};

/**
 * Map ThinkLevel to SDK reasoning level.
 */
function mapThinkLevel(thinkLevel?: ThinkLevel): SdkReasoningLevel {
  switch (thinkLevel) {
    case "off":
      return "off";
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
    default:
      return "off";
  }
}

/**
 * Map VerboseLevel to SDK verbose level.
 */
function mapVerboseLevel(verboseLevel?: VerboseLevel): SdkVerboseLevel {
  switch (verboseLevel) {
    case "off":
      return "off";
    case "on":
      return "on";
    case "full":
      return "full";
    default:
      return "off";
  }
}

/**
 * Map elevated permission level to CCSDK permission mode.
 *
 * Translates the platform's elevated permission level (from sandboxInfo)
 * to the Claude Code SDK's permission mode for file edits and other operations.
 *
 * Note: This is distinct from bashElevated which controls where exec commands run.
 * The CCSDK permissionMode controls Claude Code's built-in permission system.
 */
function mapElevatedToPermissionMode(
  elevatedLevel?: "on" | "off" | "ask" | "full",
): string | undefined {
  switch (elevatedLevel) {
    case "off":
    case "ask":
      return "default";
    case "on":
      return "acceptEdits";
    case "full":
      return "bypassPermissions";
    default:
      return undefined;
  }
}

/**
 * Extract agent ID from session key.
 */
function extractAgentId(sessionKey?: string): string {
  if (!sessionKey) return "main";
  const parts = sessionKey.split(":");
  return parts[0] || "main";
}

/**
 * Resolve user timezone from config.
 */
function resolveTimezone(config?: MoltbotConfig): string | undefined {
  const tz = config?.agents?.defaults?.userTimezone;
  if (tz) return tz;
  return typeof process !== "undefined" ? process.env.TZ : undefined;
}

/**
 * Extract skill names from snapshot.
 */
function extractSkillNames(
  skillsSnapshot?: AgentRuntimeRunParams["skillsSnapshot"],
): string[] | undefined {
  if (!skillsSnapshot?.resolvedSkills) return undefined;
  const names = skillsSnapshot.resolvedSkills
    .map((s) => s.name)
    .filter((n): n is string => Boolean(n));
  return names.length > 0 ? names : undefined;
}

/**
 * Convert an SdkRunnerResult into an AgentRuntimeResult.
 */
function adaptSdkResult(result: SdkRunnerResult, sessionId: string): AgentRuntimeResult {
  const usage = result.meta.usage
    ? {
        input: result.meta.usage.inputTokens,
        output: result.meta.usage.outputTokens,
        cacheRead: result.meta.usage.cacheReadInputTokens,
        cacheWrite: result.meta.usage.cacheCreationInputTokens,
        total: result.meta.usage.totalTokens,
      }
    : undefined;

  return {
    payloads: result.payloads.map((p) => ({
      text: p.text,
      isError: p.isError,
    })),
    meta: {
      durationMs: result.meta.durationMs,
      aborted: result.meta.aborted,
      agentMeta: {
        // Use CCSDK session ID if available (for resume), otherwise Moltbot session ID
        sessionId: result.claudeSessionId ?? sessionId,
        provider: result.meta.provider ?? "anthropic",
        model: result.meta.model ?? "default",
        runtime: "ccsdk",
        usage,
      },
      error: undefined,
    },
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    messagingToolSentTexts: result.messagingToolSentTexts,
    messagingToolSentTargets: result.messagingToolSentTargets,
  };
}

/**
 * Create a Claude Code SDK runtime instance.
 *
 * The CCSDK runtime uses the Claude Agent SDK for model execution,
 * which supports:
 * - Claude Code CLI authentication (subscription-based)
 * - Anthropic API key authentication
 * - AWS Bedrock and Google Vertex AI backends
 */
export function createCcSdkAgentRuntime(context?: CcSdkAgentRuntimeContext): AgentRuntime {
  if (!isSdkAvailable()) {
    log.warn("Claude Agent SDK not available - runtime will fail on first run");
  }

  const providerConfig = resolveProviderConfig({
    apiKey: context?.apiKey,
    authToken: context?.authToken,
    baseUrl: context?.baseUrl,
    useCliCredentials: true,
  });

  return {
    kind: "ccsdk",
    displayName: `Claude Code SDK (${providerConfig.name})`,

    async run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult> {
      const effectiveConfig = params.config ?? context?.config;
      const agentId = extractAgentId(params.sessionKey);

      // Extract CCSDK-specific options from the options bag
      const ccsdkOpts = params.ccsdkOptions ?? {};

      // Resolve effective model (from params or provider config)
      const _effectiveModel = params.model
        ? `${params.provider ?? "anthropic"}/${params.model}`
        : (ccsdkOpts.modelTiers?.sonnet ?? context?.ccsdkConfig?.models?.sonnet ?? "default");

      // Load conversation history from session file if not provided
      let conversationHistory = context?.conversationHistory;
      if (!conversationHistory && params.sessionFile) {
        conversationHistory = loadSessionHistoryForSdk({
          sessionFile: params.sessionFile,
          maxTurns: 20,
        });
      }

      // Build tools for this run (similar to how Pi runtime builds tools in attempt.ts)
      // If pre-built tools are provided via context, use those instead
      const builtInTools: AnyAgentTool[] =
        context?.tools ??
        createMoltbotCodingTools({
          // Exec tool configuration (same as Pi runtime)
          exec: {
            ...params.execOverrides,
            elevated: params.bashElevated,
          },
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          sessionKey: params.sessionKey,
          agentDir: params.agentDir ?? resolveMoltbotAgentDir(),
          workspaceDir: params.workspaceDir,
          config: effectiveConfig,
          abortSignal: params.abortSignal,
          modelProvider: params.provider,
          modelId: params.model,
          modelAuthMode: resolveModelAuthMode(params.provider ?? "anthropic"),
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          groupId: params.groupId,
        });

      // Track client tool calls for OpenResponses integration
      // Note: clientToolCallDetected is set when a client tool is invoked; future work may
      // expose this in SdkRunnerResult similar to how Pi runtime exposes it in AttemptResult.
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      void clientToolCallDetected; // Suppress unused warning (callback mutates this)

      // Convert client tools (OpenResponses hosted tools) for CCSDK
      const clientToolsConverted = params.clientTools
        ? convertClientToolsForSdk(params.clientTools, (toolName, toolParams) => {
            clientToolCallDetected = { name: toolName, params: toolParams };
          })
        : [];

      // Combine built-in tools with client tools
      const tools: AnyAgentTool[] = [...builtInTools, ...clientToolsConverted];

      const sdkResult = await runSdkAgent({
        // ─── Core shared params (spread) ────────────────────────────────────────
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        agentId,
        config: effectiveConfig,
        prompt: params.prompt,
        timeoutMs: params.timeoutMs,
        abortSignal: params.abortSignal,
        extraSystemPrompt: params.extraSystemPrompt,

        // ─── Messaging & sender context (shared) ────────────────────────────────
        messageChannel: params.messageChannel,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,

        // ─── Transformed/SDK-specific fields ────────────────────────────────────
        model: params.model ? `${params.provider ?? "anthropic"}/${params.model}` : undefined,
        providerConfig,
        reasoningLevel: mapThinkLevel(params.thinkLevel),
        verboseLevel: mapVerboseLevel(params.verboseLevel),
        timezone: resolveTimezone(effectiveConfig),
        skills: extractSkillNames(params.skillsSnapshot),
        skillsPrompt: params.skillsSnapshot?.prompt,

        // ─── CCSDK options from ccsdkOptions bag ────────────────────────────────
        hooksEnabled: ccsdkOpts.hooksEnabled ?? context?.ccsdkConfig?.hooksEnabled,
        sdkOptions: ccsdkOpts.sdkOptions ?? context?.ccsdkConfig?.options,
        modelTiers: ccsdkOpts.modelTiers ?? context?.ccsdkConfig?.models,
        claudeSessionId: params.providerSessionId,
        forkSession: ccsdkOpts.forkSession,
        // Map sandbox elevated permission level to CCSDK permission mode
        permissionMode: mapElevatedToPermissionMode(params.sandboxInfo?.elevated?.defaultLevel),
        thinkingLevel: params.thinkLevel,
        conversationHistory,
        tools,

        // ─── Streaming callbacks (adapted to SDK payload shapes) ────────────────
        onPartialReply: params.onPartialReply
          ? (payload) => params.onPartialReply?.({ text: payload.text })
          : undefined,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onBlockReply: params.onBlockReply
          ? (payload) => params.onBlockReply?.({ text: payload.text })
          : undefined,
        onBlockReplyFlush: params.onBlockReplyFlush,
        onReasoningStream: params.onReasoningStream
          ? (payload) => params.onReasoningStream?.({ text: payload.text })
          : undefined,
        onToolResult: params.onToolResult
          ? (payload) => params.onToolResult?.({ text: payload.text })
          : undefined,
        onAgentEvent: params.onAgentEvent,
      });

      // Persist session transcript for multi-turn continuity.
      if (params.sessionFile) {
        if (sdkResult.completedToolCalls && sdkResult.completedToolCalls.length > 0) {
          appendSdkToolCallsToSessionTranscript({
            sessionFile: params.sessionFile,
            toolCalls: sdkResult.completedToolCalls,
          });
        }

        appendSdkTurnPairToSessionTranscript({
          sessionFile: params.sessionFile,
          prompt: params.prompt,
          assistantText: sdkResult.payloads.find(
            (p) => !p.isError && typeof p.text === "string" && p.text.trim(),
          )?.text,
        });
      }

      return adaptSdkResult(sdkResult, params.sessionId);
    },
  };
}
