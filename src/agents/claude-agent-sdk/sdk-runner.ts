/**
 * Claude Agent SDK runner — an alternative to the Pi Agent embedded runner
 * that uses the Claude Agent SDK as the main agent runtime.
 *
 * This runner bridges Moltbot tools into the SDK via MCP, passes the user
 * prompt (with optional system prompt), streams events, and returns results
 * in a format compatible with Moltbot's reply pipeline.
 *
 * Key differences from the Pi Agent embedded runner:
 * - No multi-turn session management (SDK is stateless per query)
 * - No context window compaction (SDK handles its own context)
 * - No model registry (model selection via env vars or SDK defaults)
 * - Moltbot tools are exposed via in-process MCP server
 * - Supports env-based provider switching (Anthropic, z.AI, etc.)
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { bridgeMoltbotToolsToMcpServer } from "./tool-bridge.js";
import type { SdkRunnerQueryOptions } from "./tool-bridge.types.js";
import { extractTextFromClaudeAgentSdkEvent } from "./extract.js";
import { loadClaudeAgentSdk } from "./sdk-loader.js";
import { buildHistorySystemPromptSuffix } from "./sdk-history.js";
import { isSdkTerminalToolEventType } from "./sdk-event-checks.js";
import { buildMoltbotSdkHooks } from "./sdk-hooks.js";
import { normalizeToolName } from "../tool-policy.js";
import type {
  SdkRunnerParams,
  SdkRunnerResult,
  SdkUsageStats,
  SdkCompletedToolCall,
  SdkProviderEnv,
} from "./types.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { CcSdkModelTiers } from "../../config/types.agents.js";
import { isMessagingToolSendAction, type MessagingToolSend } from "../pi-embedded-messaging.js";
import { extractMessagingToolSend } from "../pi-embedded-subscribe.tools.js";
import { buildSystemPromptAdditionsFromParams } from "./system-prompt.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
// Session transcript recording is done in sdk-agent-runtime.ts, which receives
// completedToolCalls from the result and passes them to appendSdkToolCallsToSessionTranscript.

const log = createSubsystemLogger("agents/claude-agent-sdk/sdk-runner");

// ---------------------------------------------------------------------------
// Thinking budget mapping
// ---------------------------------------------------------------------------

/**
 * Map thinking levels to SDK budget tokens.
 * These values are tuned to match Claude's expected thinking depths.
 */
const THINKING_BUDGET_MAP: Record<ThinkLevel, number> = {
  off: 0,
  minimal: 2_000,
  low: 5_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 40_000,
};

function getThinkingBudget(level?: ThinkLevel): number | undefined {
  if (!level || level === "off") return undefined;
  return THINKING_BUDGET_MAP[level];
}

/**
 * Extract usage statistics from an SDK event.
 * Usage can appear in result events or as a separate usage event.
 */
function extractUsageFromEvent(event: unknown): SdkUsageStats | undefined {
  if (!isRecord(event)) return undefined;

  // Check for usage in the event itself
  const usageObj = event.usage as Record<string, unknown> | undefined;
  if (!usageObj || typeof usageObj !== "object") {
    // Also check for usage nested in data
    const data = event.data as Record<string, unknown> | undefined;
    const dataUsage = data?.usage as Record<string, unknown> | undefined;
    if (!dataUsage || typeof dataUsage !== "object") return undefined;
    return normalizeUsageObject(dataUsage);
  }

  return normalizeUsageObject(usageObj);
}

function normalizeUsageObject(obj: Record<string, unknown>): SdkUsageStats | undefined {
  const inputTokens =
    typeof obj.input_tokens === "number"
      ? obj.input_tokens
      : typeof obj.inputTokens === "number"
        ? obj.inputTokens
        : undefined;
  const outputTokens =
    typeof obj.output_tokens === "number"
      ? obj.output_tokens
      : typeof obj.outputTokens === "number"
        ? obj.outputTokens
        : undefined;
  const cacheReadInputTokens =
    typeof obj.cache_read_input_tokens === "number"
      ? obj.cache_read_input_tokens
      : typeof obj.cacheReadInputTokens === "number"
        ? obj.cacheReadInputTokens
        : undefined;
  const cacheCreationInputTokens =
    typeof obj.cache_creation_input_tokens === "number"
      ? obj.cache_creation_input_tokens
      : typeof obj.cacheCreationInputTokens === "number"
        ? obj.cacheCreationInputTokens
        : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }

  const totalTokens =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheReadInputTokens ?? 0) +
    (cacheCreationInputTokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EXTRACTED_CHARS = 120_000;
const DEFAULT_MCP_SERVER_NAME = "moltbot";
const DEFAULT_MAX_TURNS = 50;

// ---------------------------------------------------------------------------
// Model tier environment helpers
// ---------------------------------------------------------------------------

/**
 * Build environment variables for model tier configuration.
 *
 * The Claude Code SDK uses these environment variables to select models
 * for different task complexity tiers.
 */
function buildModelTierEnv(modelTiers?: CcSdkModelTiers): SdkProviderEnv {
  const env: SdkProviderEnv = {};

  if (modelTiers?.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelTiers.haiku;
  }
  if (modelTiers?.sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelTiers.sonnet;
  }
  if (modelTiers?.opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelTiers.opus;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Event classification helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value;
}

async function coerceAsyncIterable(value: unknown): Promise<AsyncIterable<unknown>> {
  if (isAsyncIterable(value)) return value;
  if (value instanceof Promise) {
    const awaited = await value;
    if (isAsyncIterable(awaited)) return awaited;
  }
  throw new Error("Claude Agent SDK query() did not return an async iterable.");
}

/**
 * Classify an SDK event for routing to the appropriate callback.
 *
 * The SDK event schema is undocumented and may change. We use defensive
 * heuristics to classify events into categories:
 * - "result": terminal event with final output
 * - "assistant": assistant message text (partial or complete)
 * - "tool": tool execution event
 * - "system": lifecycle/diagnostic event
 * - "unknown": unrecognized shape
 */
type EventKind = "result" | "assistant" | "tool" | "system" | "unknown";

function classifyEvent(event: unknown): { kind: EventKind; event: unknown } {
  if (!isRecord(event)) return { kind: "unknown", event };

  const type = event.type as string | undefined;

  // Terminal result event.
  if (type === "result") return { kind: "result", event };

  // Tool-related events.
  if (
    type === "tool_use" ||
    type === "tool_result" ||
    type === "tool_execution_start" ||
    type === "tool_execution_end"
  ) {
    return { kind: "tool", event };
  }

  // System/lifecycle events.
  if (type === "system" || type === "agent_start" || type === "agent_end" || type === "error") {
    return { kind: "system", event };
  }

  // Assistant message events (has text content).
  if (event.text || event.delta || event.content || event.message) {
    return { kind: "assistant", event };
  }

  return { kind: "unknown", event };
}

function normalizeSdkToolName(
  raw: string,
  mcpServerName: string,
): { name: string; rawName: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { name: "tool", rawName: "" };
  const parts = trimmed.split("__");
  const withoutMcpPrefix =
    parts.length >= 3 && parts[0] === "mcp" && parts[1] === mcpServerName
      ? parts.slice(2).join("__")
      : parts.length >= 3 && parts[0] === "mcp"
        ? parts.slice(2).join("__")
        : trimmed;
  return { name: normalizeToolName(withoutMcpPrefix), rawName: trimmed };
}

function applySdkOptionsOverrides(
  options: SdkRunnerQueryOptions,
  overrides: unknown,
): SdkRunnerQueryOptions {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return options;

  // Moltbot must keep these consistent with its own tool plumbing + prompt building.
  const protectedKeys = new Set([
    "cwd",
    "mcpServers",
    "allowedTools",
    "disallowedTools",
    "tools",
    "env",
    "systemPrompt",
    "model",
    "hooks",
  ]);

  const record = overrides as Record<string, unknown>;
  const target = options as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (protectedKeys.has(key)) continue;
    target[key] = value;
  }
  return options;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Build the SDK prompt.
 *
 * When using mcpServers, the SDK requires an AsyncIterable<SDKUserMessage>
 * as the prompt (not a plain string). We generate this from the user message.
 *
 * The SDK is stateless per query, so conversation history is injected as
 * serialized text appended to the system prompt (see buildHistorySystemPromptSuffix).
 * This provides multi-turn context without requiring structured message history.
 */
function buildSdkPrompt(params: {
  prompt: string;
  systemPrompt?: string;
}): string | AsyncIterable<{ type: "user"; message: { role: "user"; content: string } }> {
  // When there's no system prompt override, a plain string works (no mcpServers
  // requirement for plain string prompts is only for some SDK versions).
  // We always use the async iterable form for consistency and forward compat.
  const userContent = params.prompt;

  async function* generateMessages() {
    yield {
      type: "user" as const,
      message: {
        role: "user" as const,
        content: userContent,
      },
    };
  }

  return generateMessages();
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run a single agent turn using the Claude Agent SDK.
 *
 * This is the main entry point — equivalent to `runEmbeddedPiAgent()` but
 * using the Claude Agent SDK instead of the Pi Agent framework.
 */
export async function runSdkAgent(params: SdkRunnerParams): Promise<SdkRunnerResult> {
  const startedAt = Date.now();
  const mcpServerName = params.mcpServerName ?? DEFAULT_MCP_SERVER_NAME;
  const hooksEnabled = params.hooksEnabled === true;

  const emitEvent = (stream: string, data: Record<string, unknown>) => {
    try {
      void Promise.resolve(params.onAgentEvent?.({ stream, data })).catch(() => {
        // Don't let async callback errors trigger unhandled rejections.
      });
    } catch {
      // Don't let callback errors break the runner.
    }
  };

  emitEvent("lifecycle", { phase: "start", startedAt, runtime: "sdk" });
  emitEvent("sdk", { type: "sdk_runner_start", runId: params.runId });

  // -------------------------------------------------------------------------
  // Step 0: Run before_agent_start hooks
  // -------------------------------------------------------------------------

  const hookRunner = getGlobalHookRunner();
  let effectivePrompt = params.prompt;

  if (hookRunner?.hasHooks("before_agent_start")) {
    try {
      const hookResult = await hookRunner.runBeforeAgentStart(
        { prompt: params.prompt, messages: [] },
        {
          agentId: params.agentId ?? params.sessionKey?.split(":")[0] ?? "main",
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        },
      );
      if (hookResult?.prependContext) {
        effectivePrompt = `${hookResult.prependContext}\n\n${params.prompt}`;
        log.debug(`hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`);
      }
    } catch (hookErr) {
      log.warn(`before_agent_start hook failed: ${String(hookErr)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 1: Load the Claude Agent SDK
  // -------------------------------------------------------------------------

  let sdk;
  try {
    sdk = await loadClaudeAgentSdk();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to load Claude Agent SDK: ${message}`);
    emitEvent("lifecycle", {
      phase: "error",
      startedAt,
      endedAt: Date.now(),
      runtime: "sdk",
      error: message,
    });
    return {
      payloads: [
        {
          text:
            "Claude Agent SDK is not available. Install @anthropic-ai/claude-agent-sdk " +
            "and ensure Claude Code is configured on this machine.\n\n" +
            `Error: ${message}`,
          isError: true,
        },
      ],
      meta: {
        durationMs: Date.now() - startedAt,
        eventCount: 0,
        extractedChars: 0,
        truncated: false,
        error: { kind: "sdk_unavailable", message },
      },
    };
  }

  emitEvent("sdk", { type: "sdk_loaded" });

  // -------------------------------------------------------------------------
  // Step 2: Bridge Moltbot tools to MCP
  // -------------------------------------------------------------------------

  let bridgeResult;
  const tools = params.tools ?? [];

  if (tools.length > 0) {
    try {
      bridgeResult = await bridgeMoltbotToolsToMcpServer({
        name: mcpServerName,
        tools,
        abortSignal: params.abortSignal,
        // Forward tool updates through the agent event stream.
        onToolUpdate: (updateParams) => {
          emitEvent("tool", {
            phase: "update",
            name: updateParams.toolName,
            toolCallId: updateParams.toolCallId,
            update: updateParams.update,
          });
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to bridge tools to MCP: ${message}`);
      emitEvent("lifecycle", {
        phase: "error",
        startedAt,
        endedAt: Date.now(),
        runtime: "sdk",
        error: message,
      });
      return {
        payloads: [
          {
            text:
              "Failed to bridge Moltbot tools to the Claude Agent SDK.\n\n" + `Error: ${message}`,
            isError: true,
          },
        ],
        meta: {
          durationMs: Date.now() - startedAt,
          eventCount: 0,
          extractedChars: 0,
          truncated: false,
          error: { kind: "mcp_bridge_failed", message },
        },
      };
    }

    log.info(
      `Bridged ${bridgeResult.toolCount} tools to MCP server "${mcpServerName}"` +
        (bridgeResult.skippedTools.length > 0
          ? ` (skipped: ${bridgeResult.skippedTools.join(", ")})`
          : ""),
    );
    emitEvent("sdk", {
      type: "tools_bridged",
      toolCount: bridgeResult.toolCount,
      skipped: bridgeResult.skippedTools,
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: Build SDK options
  // -------------------------------------------------------------------------

  const sdkOptions: SdkRunnerQueryOptions = {
    cwd: params.workspaceDir,
    maxTurns: params.maxTurns ?? params.providerConfig?.maxTurns ?? DEFAULT_MAX_TURNS,
  };

  // MCP server with bridged Moltbot tools.
  if (bridgeResult && bridgeResult.toolCount > 0) {
    sdkOptions.mcpServers = {
      [mcpServerName]: bridgeResult.serverConfig,
    };
    sdkOptions.allowedTools = bridgeResult.allowedTools;
  }

  // Built-in Claude Code tools (default: none — Moltbot tools only via MCP).
  if (params.builtInTools && params.builtInTools.length > 0) {
    sdkOptions.tools = params.builtInTools;
    // Merge built-in tool names into allowedTools.
    sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...params.builtInTools];
  } else {
    // Disable all built-in tools so only MCP tools are available.
    sdkOptions.tools = [];
  }

  // Apply optional pass-through options (e.g. settingSources/includePartialMessages).
  applySdkOptionsOverrides(sdkOptions, params.sdkOptions);

  // Permission mode.
  if (params.permissionMode) {
    sdkOptions.permissionMode = params.permissionMode;
  }

  // Native session resume (preferred) or history injection fallback.
  // When claudeSessionId is provided, use the SDK's native resume feature
  // instead of injecting history into the system prompt.
  const useNativeSessionResume = Boolean(params.claudeSessionId);
  if (useNativeSessionResume) {
    sdkOptions.resume = params.claudeSessionId;
    if (params.forkSession) {
      sdkOptions.forkSession = true;
    }
    log.debug(`Using native session resume with ID: ${params.claudeSessionId}`);
  }

  // System prompt (with Moltbot-specific additions and conversation history suffix).
  const systemPromptAdditions = buildSystemPromptAdditionsFromParams({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    timezone: params.timezone,
    messageChannel: params.messageChannel,
    channelHints: params.channelHints,
    skills: params.skills,
  });
  // Skip history injection when using native session resume.
  const historySuffix = useNativeSessionResume
    ? ""
    : buildHistorySystemPromptSuffix(params.conversationHistory);
  const baseSystemPrompt = params.systemPrompt ?? params.extraSystemPrompt;
  const combinedSystemPrompt = [systemPromptAdditions, baseSystemPrompt, historySuffix]
    .filter(Boolean)
    .join("\n\n");
  if (combinedSystemPrompt) {
    sdkOptions.systemPrompt = combinedSystemPrompt;
  }

  // Provider env overrides (z.AI, custom endpoints, etc.) and model tier config.
  const envOverrides: Record<string, string> = {};

  // Add provider env vars.
  if (params.providerConfig?.env) {
    for (const [key, value] of Object.entries(params.providerConfig.env)) {
      if (value !== undefined) envOverrides[key] = value;
    }
  }

  // Add model tier env vars.
  const modelTierEnv = buildModelTierEnv(params.modelTiers);
  for (const [key, value] of Object.entries(modelTierEnv)) {
    if (value !== undefined) envOverrides[key] = value;
  }

  if (Object.keys(envOverrides).length > 0) {
    sdkOptions.env = envOverrides;
  }

  // Model override from provider config.
  if (params.providerConfig?.model) {
    sdkOptions.model = params.providerConfig.model;
  }

  // Hook callbacks (Claude Code hooks; richer tool + lifecycle signals).
  if (hooksEnabled) {
    sdkOptions.hooks = buildMoltbotSdkHooks({
      mcpServerName,
      emitEvent,
      onToolResult: params.onToolResult,
    }) as unknown as Record<string, unknown>;
  }

  // Thinking budget (extended thinking support).
  const thinkingBudget = getThinkingBudget(params.thinkingLevel);
  if (thinkingBudget !== undefined) {
    sdkOptions.budgetTokens = thinkingBudget;
    log.debug(`Set thinking budget to ${thinkingBudget} tokens for level: ${params.thinkingLevel}`);
  }

  // -------------------------------------------------------------------------
  // Step 4: Build the prompt
  // -------------------------------------------------------------------------

  const prompt = buildSdkPrompt({
    prompt: effectivePrompt,
    systemPrompt: combinedSystemPrompt,
  });

  // -------------------------------------------------------------------------
  // Step 5: Run the SDK query and stream events
  // -------------------------------------------------------------------------

  let eventCount = 0;
  let extractedChars = 0;
  let truncated = false;
  let resultText: string | undefined;
  let aborted = false;
  let usage: SdkUsageStats | undefined;
  let extractedSessionId: string | undefined;
  const chunks: string[] = [];
  let assistantSoFar = "";
  let didAssistantMessageStart = false;

  // Messaging tool tracking state.
  const messagingToolSentTexts: string[] = [];
  const messagingToolSentTargets: MessagingToolSend[] = [];
  // Map of pending tool calls: toolCallId -> { name, args }
  const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  // Completed tool calls for session transcript recording.
  const completedToolCalls: SdkCompletedToolCall[] = [];

  // Set up timeout if configured.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutController = new AbortController();
  if (params.timeoutMs && params.timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timeoutController.abort();
    }, params.timeoutMs);
  }

  // Combine external abort signal with timeout.
  const combinedAbort = params.abortSignal
    ? combineAbortSignals(params.abortSignal, timeoutController.signal)
    : timeoutController.signal;

  try {
    emitEvent("sdk", { type: "query_start" });

    const stream = await coerceAsyncIterable(
      sdk.query({
        prompt: prompt as string, // The SDK accepts both string and AsyncIterable
        options: sdkOptions as Record<string, unknown>,
      }),
    );

    for await (const event of stream) {
      // Check abort before processing each event.
      if (combinedAbort.aborted) {
        aborted = true;
        log.debug("Aborted during event stream");
        break;
      }

      eventCount += 1;

      // Best-effort assistant message boundary detection.
      // Some SDK versions emit `type: "message_start"`; otherwise, we fall back
      // to calling this once when we see the first assistant text.
      if (!didAssistantMessageStart && isRecord(event) && event.type === "message_start") {
        didAssistantMessageStart = true;
        try {
          void Promise.resolve(params.onAssistantMessageStart?.()).catch((err) => {
            log.debug(`onAssistantMessageStart callback error: ${String(err)}`);
          });
        } catch (err) {
          log.debug(`onAssistantMessageStart callback error: ${String(err)}`);
        }
      }

      const { kind } = classifyEvent(event);

      // Emit tool results via callback and track messaging tools.
      if (!hooksEnabled && kind === "tool") {
        const record = isRecord(event) ? (event as Record<string, unknown>) : undefined;
        const type = record && typeof record.type === "string" ? record.type : undefined;
        const phase = (() => {
          if (type === "tool_execution_start" || type === "tool_use") return "start";
          if (isSdkTerminalToolEventType(type)) return "result";
          return "update";
        })();
        const name =
          record && typeof record.name === "string"
            ? record.name
            : record && typeof record.tool_name === "string"
              ? record.tool_name
              : undefined;
        const normalizedName = name
          ? normalizeSdkToolName(name, mcpServerName)
          : { name: "tool", rawName: "" };
        const toolCallId =
          record && typeof record.id === "string"
            ? record.id
            : record && typeof record.tool_use_id === "string"
              ? record.tool_use_id
              : record && typeof record.toolCallId === "string"
                ? record.toolCallId
                : undefined;
        const toolText = extractTextFromClaudeAgentSdkEvent(event);
        const isError =
          record && typeof record.is_error === "boolean"
            ? record.is_error
            : record && typeof record.isError === "boolean"
              ? record.isError
              : Boolean(record?.error);

        // Track tool calls for session transcript and messaging deduplication.
        if (phase === "start" && toolCallId && record) {
          // Extract args from the event (tool_use events typically have input field).
          const args =
            (record.input as Record<string, unknown>) ??
            (record.arguments as Record<string, unknown>) ??
            {};
          // Track all tool calls, not just messaging tools.
          pendingToolCalls.set(toolCallId, { name: normalizedName.name, args });
        }

        // On completion, record tool call and check for messaging tool send.
        if (phase === "result" && toolCallId) {
          const pending = pendingToolCalls.get(toolCallId);
          if (pending) {
            // Record completed tool call for session transcript.
            completedToolCalls.push({
              toolCallId,
              toolName: pending.name,
              args: pending.args,
              result: toolText,
              isError,
            });

            // Check for messaging tool send (only on success).
            if (!isError && isMessagingToolSendAction(pending.name, pending.args)) {
              const sendTarget = extractMessagingToolSend(pending.name, pending.args);
              if (sendTarget) {
                messagingToolSentTargets.push(sendTarget);
              }
              // Extract text from args for deduplication.
              const textArg = pending.args.text ?? pending.args.message ?? pending.args.content;
              if (typeof textArg === "string" && textArg.trim()) {
                messagingToolSentTexts.push(textArg.trim());
              }
            }
          }
          pendingToolCalls.delete(toolCallId);
        }

        emitEvent("tool", {
          phase,
          name: normalizedName.name,
          toolCallId,
          sdkType: type,
          ...(normalizedName.rawName ? { rawName: normalizedName.rawName } : {}),
          isError,
          ...(toolText ? { resultText: toolText } : {}),
        });
      }

      if (!hooksEnabled && kind === "tool" && params.onToolResult) {
        const toolText = extractTextFromClaudeAgentSdkEvent(event);
        if (toolText) {
          try {
            // Only emit tool results for terminal tool events to match Pi semantics more closely.
            const record = isRecord(event) ? (event as Record<string, unknown>) : undefined;
            const type = record && typeof record.type === "string" ? record.type : "";
            if (isSdkTerminalToolEventType(type)) await params.onToolResult({ text: toolText });
          } catch {
            // Don't break the stream on callback errors.
          }
        }
      }

      // Emit system/lifecycle events.
      if (kind === "system" && isRecord(event)) {
        emitEvent("sdk", event as Record<string, unknown>);
      }

      // Handle terminal result event.
      if (kind === "result" && isRecord(event)) {
        const result = event.result;
        if (typeof result === "string") {
          resultText = result;
        }
        // Extract usage from result event.
        const resultUsage = extractUsageFromEvent(event);
        if (resultUsage) {
          usage = resultUsage;
        }
        // Also check for error results.
        const subtype = event.subtype;
        if (subtype === "error" && typeof event.error === "string") {
          log.warn(`SDK returned error result: ${event.error}`);
        }
        break;
      }

      // Check for usage events (some SDK versions emit these separately).
      if (isRecord(event) && (event.type === "usage" || event.type === "message_stop")) {
        const eventUsage = extractUsageFromEvent(event);
        if (eventUsage) {
          usage = eventUsage;
        }
      }

      // Extract session ID from SDK events.
      // Session ID appears in system init messages, assistant messages, and result events.
      if (!extractedSessionId && isRecord(event)) {
        const sessionId = event.session_id;
        if (typeof sessionId === "string" && sessionId) {
          extractedSessionId = sessionId;
          log.debug(`Extracted CCSDK session ID: ${sessionId}`);
        }
      }

      // Extract text from assistant messages.
      if (kind === "assistant" || kind === "unknown") {
        const text = extractTextFromClaudeAgentSdkEvent(event);
        if (!text) continue;

        const trimmed = text.trimEnd();
        if (!trimmed) continue;

        if (!didAssistantMessageStart) {
          didAssistantMessageStart = true;
          try {
            void Promise.resolve(params.onAssistantMessageStart?.()).catch((err) => {
              log.debug(`onAssistantMessageStart callback error: ${String(err)}`);
            });
          } catch (err) {
            log.debug(`onAssistantMessageStart callback error: ${String(err)}`);
          }
        }

        // Dedup: skip if this chunk is identical to or a suffix of the last.
        const last = chunks.at(-1);
        if (last && (last === trimmed || last.endsWith(trimmed))) continue;

        chunks.push(trimmed);
        extractedChars += trimmed.length;

        const prev = assistantSoFar;
        assistantSoFar = chunks.join("\n\n");
        const delta = assistantSoFar.startsWith(prev) ? assistantSoFar.slice(prev.length) : trimmed;

        emitEvent("assistant", { text: assistantSoFar, delta });

        // Stream partial reply.
        if (params.onPartialReply) {
          try {
            await params.onPartialReply({ text: assistantSoFar });
          } catch {
            // Don't break the stream on callback errors.
          }
        }

        // Truncate if we've extracted too much text.
        if (extractedChars >= DEFAULT_MAX_EXTRACTED_CHARS) {
          truncated = true;
          log.debug(`Truncated after ${extractedChars} chars`);
          break;
        }
      }
    }
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);

    const message = err instanceof Error ? err.message : String(err);

    // Check if this was a timeout.
    if (timeoutController.signal.aborted && !params.abortSignal?.aborted) {
      log.warn(`Timed out after ${params.timeoutMs}ms`);
      emitEvent("lifecycle", {
        phase: "error",
        startedAt,
        endedAt: Date.now(),
        runtime: "sdk",
        aborted: true,
        error: message,
      });
      return {
        payloads: [
          {
            text: `Agent timed out after ${params.timeoutMs}ms.`,
            isError: true,
          },
        ],
        meta: {
          durationMs: Date.now() - startedAt,
          provider: params.providerConfig?.name,
          eventCount,
          extractedChars,
          truncated,
          aborted: true,
          error: { kind: "timeout", message },
          bridge: bridgeResult
            ? {
                toolCount: bridgeResult.toolCount,
                registeredTools: bridgeResult.registeredTools,
                skippedTools: bridgeResult.skippedTools,
              }
            : undefined,
        },
      };
    }

    // Check if this was an external abort.
    if (params.abortSignal?.aborted) {
      aborted = true;
    } else {
      log.error(`Query failed: ${message}`);
      emitEvent("lifecycle", {
        phase: "error",
        startedAt,
        endedAt: Date.now(),
        runtime: "sdk",
        error: message,
      });
      return {
        payloads: [
          {
            text: `Agent run failed: ${message}`,
            isError: true,
          },
        ],
        meta: {
          durationMs: Date.now() - startedAt,
          provider: params.providerConfig?.name,
          eventCount,
          extractedChars,
          truncated,
          error: { kind: "run_failed", message },
          bridge: bridgeResult
            ? {
                toolCount: bridgeResult.toolCount,
                registeredTools: bridgeResult.registeredTools,
                skippedTools: bridgeResult.skippedTools,
              }
            : undefined,
        },
      };
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  // -------------------------------------------------------------------------
  // Step 6: Build result
  // -------------------------------------------------------------------------

  const text = (resultText ?? chunks.join("\n\n")).trim();

  if (!text) {
    emitEvent("lifecycle", {
      phase: "error",
      startedAt,
      endedAt: Date.now(),
      runtime: "sdk",
      aborted,
      error: "No text output",
    });
    return {
      payloads: [
        {
          text: "Agent completed but produced no text output.",
          isError: true,
        },
      ],
      meta: {
        durationMs: Date.now() - startedAt,
        provider: params.providerConfig?.name,
        eventCount,
        extractedChars: 0,
        truncated: false,
        aborted,
        usage,
        error: aborted ? undefined : { kind: "no_output", message: "No text output" },
        bridge: bridgeResult
          ? {
              toolCount: bridgeResult.toolCount,
              registeredTools: bridgeResult.registeredTools,
              skippedTools: bridgeResult.skippedTools,
            }
          : undefined,
      },
    };
  }

  const suffix = truncated ? "\n\n[Output truncated]" : "";
  const finalText = `${text}${suffix}`;

  // Emit the final block reply.
  if (params.onBlockReply) {
    try {
      await params.onBlockReply({ text: finalText });
    } catch {
      // Don't fail the run on callback errors.
    }
  }

  emitEvent("sdk", {
    type: "sdk_runner_end",
    eventCount,
    extractedChars,
    truncated,
    aborted,
    durationMs: Date.now() - startedAt,
  });
  emitEvent("lifecycle", {
    phase: "end",
    startedAt,
    endedAt: Date.now(),
    runtime: "sdk",
    aborted,
    truncated,
  });

  // Run agent_end hooks (fire-and-forget).
  if (hookRunner?.hasHooks("agent_end")) {
    hookRunner
      .runAgentEnd(
        {
          messages: [],
          success: !aborted,
          durationMs: Date.now() - startedAt,
        },
        {
          agentId: params.agentId ?? params.sessionKey?.split(":")[0] ?? "main",
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        },
      )
      .catch((err) => {
        log.warn(`agent_end hook failed: ${err}`);
      });
  }

  return {
    payloads: [{ text: finalText }],
    meta: {
      durationMs: Date.now() - startedAt,
      provider: params.providerConfig?.name,
      eventCount,
      extractedChars,
      truncated,
      aborted,
      usage,
      bridge: bridgeResult
        ? {
            toolCount: bridgeResult.toolCount,
            registeredTools: bridgeResult.registeredTools,
            skippedTools: bridgeResult.skippedTools,
          }
        : undefined,
    },
    didSendViaMessagingTool: messagingToolSentTargets.length > 0,
    messagingToolSentTexts: messagingToolSentTexts.length > 0 ? messagingToolSentTexts : undefined,
    messagingToolSentTargets:
      messagingToolSentTargets.length > 0 ? messagingToolSentTargets : undefined,
    completedToolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
    claudeSessionId: extractedSessionId,
  };
}

// ---------------------------------------------------------------------------
// Utility: combine abort signals
// ---------------------------------------------------------------------------

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
