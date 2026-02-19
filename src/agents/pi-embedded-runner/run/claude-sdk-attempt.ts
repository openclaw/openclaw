/**
 * Claude Agent SDK attempt — Alternative to `attempt.ts` that runs the prompt
 * through the Claude Agent SDK instead of pi-agent.
 *
 * Returns the same `EmbeddedRunAttemptResult` so the error handling, compaction,
 * auth rotation, and payload building in `run.ts` work unchanged.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SDKAssistantMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import type { NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Subset of EmbeddedRunAttemptParams relevant to the Claude SDK path. */
export type ClaudeSdkAttemptParams = {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir: string;
  prompt: string;
  images?: Array<{ type: "image"; mediaType: string; data: string }>;
  provider: string;
  modelId: string;
  apiKey: string;
  apiKeyMode: "api-key" | "oauth" | "token" | "aws-sdk";
  thinkLevel: string;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  extraSystemPrompt?: string;
  config?: Record<string, unknown>;
  // Streaming callbacks (same interface as pi-agent path)
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  onAssistantMessageStart?: () => void | Promise<void>;
};

/**
 * Run a single attempt using the Claude Agent SDK.
 *
 * This spawns a Claude Code subprocess via the SDK's `query()` function,
 * streams events, and maps the result to EmbeddedRunAttemptResult.
 */
export async function runClaudeSdkAttempt(
  params: ClaudeSdkAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const abortController = new AbortController();
  let aborted = false;
  let timedOut = false;

  // Wire external abort signal
  if (params.abortSignal) {
    if (params.abortSignal.aborted) {
      aborted = true;
    } else {
      params.abortSignal.addEventListener("abort", () => {
        aborted = true;
        abortController.abort();
      });
    }
  }

  // Timeout
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, params.timeoutMs);

  const assistantTexts: string[] = [];
  const toolMetas: Array<{ toolName: string; meta?: string }> = [];
  let lastAssistantRaw: SDKAssistantMessage | undefined;
  let resultMessage: SDKResultMessage | undefined;
  let sessionIdUsed = params.sessionId;
  let currentText = "";
  let compactionCount = 0;

  // Detect whether an existing Claude Code session file is present.
  // If the session already exists, use `resume` for proper continuation.
  // If this is the first turn, use `sessionId` to create the session.
  const encodedCwd = params.workspaceDir.replace(/[/.]/g, "-");
  const claudeSessionFile = join(
    homedir(),
    ".claude",
    "projects",
    encodedCwd,
    `${params.sessionId}.jsonl`,
  );
  const isResume = existsSync(claudeSessionFile);

  // Emit lifecycle start so the gateway/TUI knows the run has begun
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt: Date.now() },
  });

  try {
    const q = query({
      prompt: params.prompt,
      options: {
        abortController,
        model: params.modelId,
        cwd: params.workspaceDir,
        systemPrompt: params.extraSystemPrompt
          ? { type: "preset", preset: "claude_code", append: params.extraSystemPrompt }
          : { type: "preset", preset: "claude_code" },
        // Use all built-in Claude Code tools
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        // First turn: create session with sessionId. Subsequent turns: resume existing session.
        ...(isResume ? { resume: params.sessionId } : { sessionId: params.sessionId }),
        includePartialMessages: true,
        thinking: mapThinkLevel(params.thinkLevel),
        // Pass the resolved API key via the correct env var based on auth mode.
        // OAuth/token credentials must use CLAUDE_CODE_OAUTH_TOKEN (Bearer header),
        // while API keys use ANTHROPIC_API_KEY (x-api-key header).
        env: {
          ...process.env,
          ...(params.apiKeyMode === "oauth" || params.apiKeyMode === "token"
            ? { CLAUDE_CODE_OAUTH_TOKEN: params.apiKey, ANTHROPIC_API_KEY: undefined }
            : { ANTHROPIC_API_KEY: params.apiKey }),
          CLAUDECODE: undefined,
        },
      },
    });

    for await (const msg of q) {
      const message = msg;

      switch (message.type) {
        case "system": {
          const sysMsg = message as unknown as {
            subtype?: string;
            session_id?: string;
            status?: string;
          };
          if (sysMsg.subtype === "init") {
            sessionIdUsed = sysMsg.session_id ?? sessionIdUsed;
          }
          if (sysMsg.subtype === "status" && sysMsg.status === "compacting") {
            compactionCount++;
          }
          break;
        }

        case "stream_event": {
          const evt = (message as unknown as { event?: Record<string, unknown> }).event as
            | undefined
            | {
                type?: string;
                delta?: { type?: string; text?: string };
                content_block?: { type?: string; name?: string; id?: string };
              };
          if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            const text = evt.delta.text ?? "";
            currentText += text;
            // Emit assistant event so the gateway populates the chat buffer for TUI/WS clients
            emitAgentEvent({
              runId: params.runId,
              stream: "assistant",
              data: { text: currentText, delta: text },
            });
            await params.onPartialReply?.({ text });
          }
          if (evt?.type === "content_block_start" && evt.content_block?.type === "tool_use") {
            // Flush any pending text before tool execution
            if (currentText.trim()) {
              await params.onBlockReplyFlush?.();
              await params.onBlockReply?.({ text: currentText });
              assistantTexts.push(currentText);
              currentText = "";
            }
            const toolName = evt.content_block.name ?? "unknown";
            toolMetas.push({ toolName });
            params.onAgentEvent?.({
              stream: "tool_use_start",
              data: {
                toolCallId: evt.content_block.id ?? "",
                toolName,
              },
            });
          }
          if (evt?.type === "message_start") {
            await params.onAssistantMessageStart?.();
          }
          break;
        }

        // Handle tool progress and summary messages
        case "tool_use_summary" as string: {
          const summary = message as unknown as { tool_name?: string; result?: string };
          if (summary.tool_name) {
            await params.onToolResult?.({
              text: summary.result ?? `[${summary.tool_name} completed]`,
            });
          }
          break;
        }

        case "assistant": {
          lastAssistantRaw = message as SDKAssistantMessage;
          // Note: onAssistantMessageStart is called in the message_start stream event above,
          // so we don't call it again here to avoid duplicate typing indicator signals.
          // Finalize any remaining streamed text
          if (currentText.trim()) {
            await params.onBlockReplyFlush?.();
            await params.onBlockReply?.({ text: currentText });
            assistantTexts.push(currentText);
            currentText = "";
          } else {
            // If no streaming deltas were received, extract text from the full assistant message
            const assistantContent = (message as SDKAssistantMessage)?.message?.content;
            if (Array.isArray(assistantContent)) {
              const fullText = (assistantContent as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text)
                .join("");
              if (fullText.trim()) {
                // Emit assistant event for gateway/TUI so they see the text
                emitAgentEvent({
                  runId: params.runId,
                  stream: "assistant",
                  data: { text: fullText, delta: fullText },
                });
                await params.onBlockReplyFlush?.();
                await params.onBlockReply?.({ text: fullText });
                assistantTexts.push(fullText);
              }
            }
          }
          break;
        }

        case "result": {
          resultMessage = message as SDKResultMessage;
          break;
        }
      }
    }
  } catch (err) {
    if (aborted || timedOut) {
      // Expected — abort or timeout
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: aborted ? "error" : "end",
          endedAt: Date.now(),
          error: aborted ? "aborted" : "timeout",
        },
      });
    } else {
      clearTimeout(timeout);
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: { phase: "error", endedAt: Date.now(), error: String(err) },
      });
      return {
        aborted,
        timedOut,
        timedOutDuringCompaction: false,
        promptError: err,
        sessionIdUsed,
        messagesSnapshot: [],
        assistantTexts,
        toolMetas,
        lastAssistant: undefined,
        lastToolError: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        compactionCount,
      };
    }
  } finally {
    clearTimeout(timeout);
  }

  // Map the SDK result to the pi-agent-compatible format
  const usage = mapSdkUsage(resultMessage);
  const lastAssistant = mapSdkAssistantMessage(
    lastAssistantRaw,
    resultMessage,
    params.provider,
    params.modelId,
  );

  // Emit lifecycle end so the gateway sends the final event to TUI/WS clients
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now() },
  });

  return {
    aborted,
    timedOut,
    timedOutDuringCompaction: false,
    promptError: null,
    sessionIdUsed,
    messagesSnapshot: [],
    assistantTexts,
    toolMetas,
    lastAssistant,
    lastToolError: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    attemptUsage: usage,
    compactionCount,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapThinkLevel(
  level: string,
): { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" } {
  switch (level) {
    case "high":
      return { type: "adaptive" };
    case "medium":
      return { type: "enabled", budgetTokens: 10_000 };
    case "low":
      return { type: "enabled", budgetTokens: 2_000 };
    case "minimal":
      return { type: "enabled", budgetTokens: 500 };
    default:
      return { type: "disabled" };
  }
}

function mapSdkUsage(result: SDKResultMessage | undefined): NormalizedUsage | undefined {
  if (!result) {
    return undefined;
  }
  const usage = (
    result as unknown as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }
  ).usage;
  if (!usage) {
    return undefined;
  }
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}

/**
 * Map SDK assistant message to pi-ai's AssistantMessage shape.
 * This is a best-effort mapping — only fields used by run.ts are populated.
 */
function mapSdkAssistantMessage(
  raw: SDKAssistantMessage | undefined,
  result: SDKResultMessage | undefined,
  provider: string,
  modelId: string,
): AssistantMessage | undefined {
  if (!raw && !result) {
    return undefined;
  }

  const betaMessage = raw?.message;
  const resultRecord = result as unknown as Record<string, unknown> | undefined;
  const stopReason =
    betaMessage?.stop_reason ?? (resultRecord?.stop_reason as string | undefined) ?? "end_turn";
  const usage = betaMessage?.usage;
  const errorType = raw?.error;

  // Extract text from the assistant message
  const textContent = (betaMessage?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => ("text" in c ? (c as { text: string }).text : ""))
    .join("");

  const resultErrors = resultRecord?.errors as string[] | undefined;

  // Best-effort mapping — only fields consumed by run.ts are populated.
  // Cast required because AssistantMessage expects pi-ai-specific fields (api, timestamp, etc.)
  // that don't exist in the SDK context.
  return {
    role: "assistant",
    content: textContent,
    provider,
    model: modelId,
    stopReason: errorType ? "error" : stopReason === "end_turn" ? "end" : stopReason,
    errorMessage: errorType
      ? mapSdkErrorType(errorType)
      : result?.subtype !== "success"
        ? resultErrors?.join(", ")
        : undefined,
    usage: usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadInputTokens: usage.cache_read_input_tokens,
          cacheCreationInputTokens: usage.cache_creation_input_tokens,
        }
      : undefined,
  } as unknown as AssistantMessage;
}

function mapSdkErrorType(errorType: string): string {
  switch (errorType) {
    case "authentication_failed":
      return "Authentication failed. Check your API key.";
    case "billing_error":
      return "Billing error. Check your account status.";
    case "rate_limit":
      return "Rate limit exceeded. Please try again later.";
    case "server_error":
      return "Server error from Anthropic API.";
    case "max_output_tokens":
      return "Maximum output tokens exceeded.";
    default:
      return `API error: ${errorType}`;
  }
}
