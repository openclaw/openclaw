/**
 * Claude Agent SDK runner — an alternative to the Pi Agent embedded runner
 * that uses the Claude Agent SDK as the main agent runtime.
 *
 * This runner bridges Clawdbot tools into the SDK via MCP, passes the user
 * prompt (with optional system prompt), streams events, and returns results
 * in a format compatible with Clawdbot's reply pipeline.
 *
 * Key differences from the Pi Agent embedded runner:
 * - No multi-turn session management (SDK is stateless per query)
 * - No context window compaction (SDK handles its own context)
 * - No model registry (model selection via env vars or SDK defaults)
 * - Clawdbot tools are exposed via in-process MCP server
 * - Supports env-based provider switching (Anthropic, z.AI, etc.)
 */

import { logDebug, logError, logInfo, logWarn } from "../../logger.js";
import { bridgeClawdbotToolsToMcpServer } from "./tool-bridge.js";
import type { SdkRunnerQueryOptions } from "./tool-bridge.types.js";
import { extractTextFromClaudeAgentSdkEvent } from "./extract.js";
import { loadClaudeAgentSdk } from "./sdk.js";
import { buildHistorySystemPromptSuffix } from "./sdk-history.js";
import type { SdkRunnerParams, SdkRunnerResult } from "./sdk-runner.types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EXTRACTED_CHARS = 120_000;
const DEFAULT_MCP_SERVER_NAME = "clawdbot";
const DEFAULT_MAX_TURNS = 50;

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

  const emitEvent = (stream: string, data: Record<string, unknown>) => {
    try {
      params.onAgentEvent?.({ stream, data });
    } catch {
      // Don't let callback errors break the runner.
    }
  };

  emitEvent("lifecycle", { type: "sdk_runner_start", runId: params.runId });

  // -------------------------------------------------------------------------
  // Step 1: Load the Claude Agent SDK
  // -------------------------------------------------------------------------

  let sdk;
  try {
    sdk = await loadClaudeAgentSdk();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[sdk-runner] Failed to load Claude Agent SDK: ${message}`);
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

  emitEvent("lifecycle", { type: "sdk_loaded" });

  // -------------------------------------------------------------------------
  // Step 2: Bridge Clawdbot tools to MCP
  // -------------------------------------------------------------------------

  let bridgeResult;
  try {
    bridgeResult = await bridgeClawdbotToolsToMcpServer({
      name: mcpServerName,
      tools: params.tools,
      abortSignal: params.abortSignal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[sdk-runner] Failed to bridge tools to MCP: ${message}`);
    return {
      payloads: [
        {
          text:
            "Failed to bridge Clawdbot tools to the Claude Agent SDK.\n\n" + `Error: ${message}`,
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

  logInfo(
    `[sdk-runner] Bridged ${bridgeResult.toolCount} tools to MCP server "${mcpServerName}"` +
      (bridgeResult.skippedTools.length > 0
        ? ` (skipped: ${bridgeResult.skippedTools.join(", ")})`
        : ""),
  );
  emitEvent("lifecycle", {
    type: "tools_bridged",
    toolCount: bridgeResult.toolCount,
    skipped: bridgeResult.skippedTools,
  });

  // -------------------------------------------------------------------------
  // Step 3: Build SDK options
  // -------------------------------------------------------------------------

  const sdkOptions: SdkRunnerQueryOptions = {
    cwd: params.workspaceDir,
    maxTurns: params.maxTurns ?? params.provider?.maxTurns ?? DEFAULT_MAX_TURNS,
  };

  // MCP server with bridged Clawdbot tools.
  if (bridgeResult.toolCount > 0) {
    sdkOptions.mcpServers = {
      [mcpServerName]: bridgeResult.serverConfig,
    };
    sdkOptions.allowedTools = bridgeResult.allowedTools;
  }

  // Built-in Claude Code tools (default: none — Clawdbot tools only via MCP).
  if (params.builtInTools && params.builtInTools.length > 0) {
    sdkOptions.tools = params.builtInTools;
    // Merge built-in tool names into allowedTools.
    sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...params.builtInTools];
  } else {
    // Disable all built-in tools so only MCP tools are available.
    sdkOptions.tools = [];
  }

  // Permission mode.
  if (params.permissionMode) {
    sdkOptions.permissionMode = params.permissionMode;
  }

  // System prompt (with optional conversation history suffix).
  const historySuffix = buildHistorySystemPromptSuffix(params.conversationHistory);
  if (params.systemPrompt || historySuffix) {
    sdkOptions.systemPrompt = (params.systemPrompt ?? "") + historySuffix;
  }

  // Provider env overrides (z.AI, custom endpoints, etc.).
  if (params.provider?.env) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(params.provider.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (Object.keys(env).length > 0) {
      sdkOptions.env = env;
    }
  }

  // Model override from provider config.
  if (params.provider?.model) {
    sdkOptions.model = params.provider.model;
  }

  // -------------------------------------------------------------------------
  // Step 4: Build the prompt
  // -------------------------------------------------------------------------

  const prompt = buildSdkPrompt({
    prompt: params.prompt,
    systemPrompt: params.systemPrompt,
  });

  // -------------------------------------------------------------------------
  // Step 5: Run the SDK query and stream events
  // -------------------------------------------------------------------------

  let eventCount = 0;
  let extractedChars = 0;
  let truncated = false;
  let resultText: string | undefined;
  let aborted = false;
  const chunks: string[] = [];

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
    emitEvent("lifecycle", { type: "query_start" });

    const stream = await coerceAsyncIterable(
      sdk.query({
        prompt: prompt as string, // The SDK accepts both string and AsyncIterable
        options: sdkOptions as Record<string, unknown>,
      }),
    );

    void params.onAssistantMessageStart?.();

    for await (const event of stream) {
      // Check abort before processing each event.
      if (combinedAbort.aborted) {
        aborted = true;
        logDebug("[sdk-runner] Aborted during event stream");
        break;
      }

      eventCount += 1;

      const { kind } = classifyEvent(event);

      // Emit tool results via callback.
      if (kind === "tool" && params.onToolResult) {
        const toolText = extractTextFromClaudeAgentSdkEvent(event);
        if (toolText) {
          try {
            await params.onToolResult({ text: toolText });
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
        // Also check for error results.
        const subtype = event.subtype;
        if (subtype === "error" && typeof event.error === "string") {
          logWarn(`[sdk-runner] SDK returned error result: ${event.error}`);
        }
        break;
      }

      // Extract text from assistant messages.
      if (kind === "assistant" || kind === "unknown") {
        const text = extractTextFromClaudeAgentSdkEvent(event);
        if (!text) continue;

        const trimmed = text.trimEnd();
        if (!trimmed) continue;

        // Dedup: skip if this chunk is identical to or a suffix of the last.
        const last = chunks.at(-1);
        if (last && (last === trimmed || last.endsWith(trimmed))) continue;

        chunks.push(trimmed);
        extractedChars += trimmed.length;

        // Stream partial reply.
        if (params.onPartialReply) {
          try {
            await params.onPartialReply({ text: trimmed });
          } catch {
            // Don't break the stream on callback errors.
          }
        }

        // Truncate if we've extracted too much text.
        if (extractedChars >= DEFAULT_MAX_EXTRACTED_CHARS) {
          truncated = true;
          logDebug(`[sdk-runner] Truncated after ${extractedChars} chars`);
          break;
        }
      }
    }
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);

    const message = err instanceof Error ? err.message : String(err);

    // Check if this was a timeout.
    if (timeoutController.signal.aborted && !params.abortSignal?.aborted) {
      logWarn(`[sdk-runner] Timed out after ${params.timeoutMs}ms`);
      return {
        payloads: [
          {
            text: `Agent timed out after ${params.timeoutMs}ms.`,
            isError: true,
          },
        ],
        meta: {
          durationMs: Date.now() - startedAt,
          provider: params.provider?.name,
          eventCount,
          extractedChars,
          truncated,
          aborted: true,
          error: { kind: "timeout", message },
          bridge: {
            toolCount: bridgeResult.toolCount,
            registeredTools: bridgeResult.registeredTools,
            skippedTools: bridgeResult.skippedTools,
          },
        },
      };
    }

    // Check if this was an external abort.
    if (params.abortSignal?.aborted) {
      aborted = true;
    } else {
      logError(`[sdk-runner] Query failed: ${message}`);
      return {
        payloads: [
          {
            text: `Agent run failed: ${message}`,
            isError: true,
          },
        ],
        meta: {
          durationMs: Date.now() - startedAt,
          provider: params.provider?.name,
          eventCount,
          extractedChars,
          truncated,
          error: { kind: "run_failed", message },
          bridge: {
            toolCount: bridgeResult.toolCount,
            registeredTools: bridgeResult.registeredTools,
            skippedTools: bridgeResult.skippedTools,
          },
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
    return {
      payloads: [
        {
          text: "Agent completed but produced no text output.",
          isError: true,
        },
      ],
      meta: {
        durationMs: Date.now() - startedAt,
        provider: params.provider?.name,
        eventCount,
        extractedChars: 0,
        truncated: false,
        aborted,
        error: aborted ? undefined : { kind: "no_output", message: "No text output" },
        bridge: {
          toolCount: bridgeResult.toolCount,
          registeredTools: bridgeResult.registeredTools,
          skippedTools: bridgeResult.skippedTools,
        },
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

  emitEvent("lifecycle", {
    type: "sdk_runner_end",
    eventCount,
    extractedChars,
    truncated,
    aborted,
    durationMs: Date.now() - startedAt,
  });

  return {
    payloads: [{ text: finalText }],
    meta: {
      durationMs: Date.now() - startedAt,
      provider: params.provider?.name,
      eventCount,
      extractedChars,
      truncated,
      aborted,
      bridge: {
        toolCount: bridgeResult.toolCount,
        registeredTools: bridgeResult.registeredTools,
        skippedTools: bridgeResult.skippedTools,
      },
    },
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
