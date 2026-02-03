/**
 * Claude Agent SDK runner — an alternative to the Pi Agent embedded runner
 * that uses the Claude Agent SDK as the main agent runtime.
 *
 * This runner bridges Clawdbrain tools into the SDK via MCP, passes the user
 * prompt (with optional system prompt), streams events, and returns results
 * in a format compatible with Clawdbrain's reply pipeline.
 *
 * Key differences from the Pi Agent embedded runner:
 * - No multi-turn session management (SDK is stateless per query)
 * - No context window compaction (SDK handles its own context)
 * - No model registry (model selection via env vars or SDK defaults)
 * - Clawdbrain tools are exposed via in-process MCP server
 * - Supports env-based provider switching (Anthropic, z.AI, etc.)
 */

import type { SdkRunnerParams, SdkRunnerResult } from "./sdk-runner.types.js";
import type { SdkRunnerQueryOptions } from "./tool-bridge.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatMcpToolNamesForLog } from "../../mcp/tool-name-format.js";
import { normalizeToolName } from "../tool-policy.js";

const log = createSubsystemLogger("sdk-runner");
import { normalizeUsage, type NormalizedUsage, type UsageLike } from "../usage.js";
import { extractTextFromClaudeAgentSdkEvent } from "./extract.js";
import { isSdkTerminalToolEventType } from "./sdk-event-checks.js";
import { buildClawdbrainSdkHooks } from "./sdk-hooks.js";
import { loadClaudeAgentSdk } from "./sdk.js";
import { bridgeClawdbrainToolsToMcpServer } from "./tool-bridge.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EXTRACTED_CHARS = 120_000;
const DEFAULT_MCP_SERVER_NAME = "clawdbrain";
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
  if (isAsyncIterable(value)) {
    return value;
  }
  if (value instanceof Promise) {
    const awaited = await value;
    if (isAsyncIterable(awaited)) {
      return awaited;
    }
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
  if (!isRecord(event)) {
    return { kind: "unknown", event };
  }

  const type = event.type as string | undefined;

  // Terminal result event.
  if (type === "result") {
    return { kind: "result", event };
  }

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
  if (!trimmed) {
    return { name: "tool", rawName: "" };
  }
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
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return options;
  }

  // Clawdbrain must keep these consistent with its own tool plumbing + prompt building.
  // Also protect session-related keys to ensure auto-compaction works correctly.
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
    "persistSession", // Required for auto-compaction (must stay true)
    "resume", // Managed by claudeSessionId param
  ]);

  const record = overrides as Record<string, unknown>;
  const target = options as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (protectedKeys.has(key)) {
      continue;
    }
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
 * Session continuity is handled via the SDK's native `resume` option, which
 * avoids re-serializing conversation history on every request.
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

  // Log *real* MCP tools (tools with the `mcp__{server}__{tool}` prefix) that were
  // added to the session tool list (e.g. from configured `mcpServers`).
  // Important: do NOT log bridged OpenClaw native tools as "MCP tools" just
  // because we expose them to the SDK through an in-process MCP server.
  const realMcpToolLog = formatMcpToolNamesForLog(params.tools.map((t) => t.name));
  if (realMcpToolLog.formatted.length > 0) {
    const total = realMcpToolLog.formatted.length + realMcpToolLog.remaining;
    log.info(
      `sdk mcp tools: runId=${params.runId} sessionId=${params.sessionId} claudeSessionId=${params.claudeSessionId ?? "new"} mcpToolsCount=${total} mcpTools=${realMcpToolLog.formatted.join(",")}${realMcpToolLog.truncated ? ` ...(+${realMcpToolLog.remaining})` : ""}`,
    );
  }

  const emitEvent = (stream: string, data: Record<string, unknown>) => {
    try {
      void Promise.resolve(params.onAgentEvent?.({ stream, data })).catch(() => {
        // Don't let async callback errors trigger unhandled rejections.
      });
    } catch {
      // Don't let callback errors break the runner.
    }
  };

  emitEvent("lifecycle", { phase: "start", startedAt, runtime: "claude" });
  emitEvent("sdk", { type: "sdk_runner_start", runId: params.runId });

  // -------------------------------------------------------------------------
  // Step 1: Load the Claude Agent SDK
  // -------------------------------------------------------------------------

  let sdk;
  try {
    log.trace("Loading Claude Agent SDK...");
    sdk = await loadClaudeAgentSdk();
    log.trace("Claude Agent SDK loaded successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    log.error(`Failed to load Claude Agent SDK: ${message}`);
    if (stack) {
      log.trace(`Stack trace:\n${stack}`);
    }
    emitEvent("lifecycle", {
      phase: "error",
      startedAt,
      endedAt: Date.now(),
      runtime: "claude",
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
  // Step 2: Bridge Clawdbrain tools to MCP
  // -------------------------------------------------------------------------

  let bridgeResult;
  try {
    log.trace(`Bridging ${params.tools.length} tools to MCP server "${mcpServerName}"...`);
    bridgeResult = await bridgeClawdbrainToolsToMcpServer({
      name: mcpServerName,
      tools: params.tools,
      abortSignal: params.abortSignal,
    });
    log.trace(`Tool bridge complete: ${bridgeResult.toolCount} tools registered`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    log.error(`Failed to bridge tools to MCP: ${message}`);
    if (stack) {
      log.trace(`Stack trace:\n${stack}`);
    }
    emitEvent("lifecycle", {
      phase: "error",
      startedAt,
      endedAt: Date.now(),
      runtime: "claude",
      error: message,
    });
    return {
      payloads: [
        {
          text:
            "Failed to bridge Clawdbrain tools to the Claude Agent SDK.\n\n" +
            `This usually means the MCP SDK (@modelcontextprotocol/sdk) is not installed ` +
            `or is incompatible with the current Claude Agent SDK version.\n\n` +
            `Error: ${message}`,
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

  log.debug(
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

  // -------------------------------------------------------------------------
  // Step 3: Build SDK options
  // -------------------------------------------------------------------------

  const sdkOptions: SdkRunnerQueryOptions = {
    cwd: params.workspaceDir,
    maxTurns: params.maxTurns ?? params.provider?.maxTurns ?? DEFAULT_MAX_TURNS,
    // Ensure session persistence is enabled for auto-compaction to work.
    // When persistSession is false, sessions are not saved to ~/.claude/projects/
    // and cannot be compacted (the SDK loses the ability to manage context window).
    persistSession: true,
  };

  // MCP server with bridged Clawdbrain tools.
  if (bridgeResult.toolCount > 0) {
    sdkOptions.mcpServers = {
      [mcpServerName]: bridgeResult.serverConfig,
    };
    sdkOptions.allowedTools = bridgeResult.allowedTools;
  }

  // Built-in Claude Code tools (default: none — Clawdbrain tools only via MCP).
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

  // Model selection (e.g., "sonnet", "opus", "haiku", or full model ID).
  if (params.model) {
    sdkOptions.model = params.model;
    log.trace(`Using model: ${params.model}`);
  }

  // Extended thinking budget (token allocation for reasoning).
  if (params.thinkingBudget && params.thinkingBudget > 0) {
    sdkOptions.thinkingBudget = params.thinkingBudget;
    log.debug(`Extended thinking enabled with budget: ${params.thinkingBudget} tokens`);
  }

  // System prompt (no history suffix - we use SDK's native session resume instead).
  if (params.systemPrompt) {
    sdkOptions.systemPrompt = params.systemPrompt;
  }

  // Resume from previous Claude Code session if available (avoids re-serializing history).
  if (params.claudeSessionId) {
    sdkOptions.resume = params.claudeSessionId;
    log.debug(`Resuming Claude Code session: ${params.claudeSessionId}`);
  }

  // Provider env overrides (z.AI, custom endpoints, etc.).
  // IMPORTANT: The SDK uses options.env as the *complete* env for the spawned
  // process (falling back to process.env only when env is omitted entirely).
  // We must merge with process.env so PATH/HOME/etc. are preserved.
  if (params.provider?.env) {
    const providerEntries = Object.entries(params.provider.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    if (providerEntries.length > 0) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      for (const [key, value] of providerEntries) {
        env[key] = value;
      }
      sdkOptions.env = env;
    }
  }

  // Model override from provider config.
  if (params.provider?.model) {
    sdkOptions.model = params.provider.model;
  }

  // Beta features (e.g., 1M context window for Sonnet 4/4.5).
  // Priority: params.betas > provider.betas
  const betas = params.betas ?? params.provider?.betas;
  if (betas && betas.length > 0) {
    sdkOptions.betas = betas;
    log.debug(`Beta features enabled: ${betas.join(", ")}`);
  }

  // Hook callbacks (Claude Code hooks; richer tool + lifecycle signals).
  if (hooksEnabled) {
    sdkOptions.hooks = buildClawdbrainSdkHooks({
      mcpServerName,
      emitEvent,
      onToolResult: params.onToolResult,
    }) as unknown as Record<string, unknown>;
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
  let assistantSoFar = "";
  let didAssistantMessageStart = false;
  let returnedSessionId: string | undefined;

  // Usage and turn tracking
  let accumulatedUsage: NormalizedUsage | undefined;
  let turnCount = 0;

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
    const promptLen = typeof prompt === "string" ? prompt.length : "(async)";
    log.debug(`Starting SDK query (prompt: ${promptLen} chars, maxTurns: ${sdkOptions.maxTurns})`);

    const stream = await coerceAsyncIterable(
      sdk.query({
        prompt: prompt as string, // The SDK accepts both string and AsyncIterable
        options: sdkOptions as Record<string, unknown>,
      }),
    );
    log.debug("SDK query stream created, iterating events...");

    for await (const event of stream) {
      // Check abort before processing each event.
      if (combinedAbort.aborted) {
        aborted = true;
        log.trace("Aborted during event stream");
        break;
      }

      eventCount += 1;

      // Diagnostic: log raw event types for debugging stream issues.
      const eventType = isRecord(event) ? String(event.type) : "non-object";
      log.trace(`Event #${eventCount}: type=${eventType}`);

      // Best-effort assistant message boundary detection.
      // Some SDK versions emit `type: "message_start"`; otherwise, we fall back
      // to calling this once when we see the first assistant text.
      if (!didAssistantMessageStart && isRecord(event) && event.type === "message_start") {
        didAssistantMessageStart = true;
        turnCount += 1;
        try {
          void Promise.resolve(params.onAssistantMessageStart?.()).catch((err) => {
            log.trace(`onAssistantMessageStart callback error: ${String(err)}`);
          });
        } catch (err) {
          log.trace(`onAssistantMessageStart callback error: ${String(err)}`);
        }
      }

      // Extract and accumulate usage from any event that has it.
      // Claude Agent SDK can include usage in message_delta, message_stop, or result events.
      if (isRecord(event)) {
        const eventUsage = event.usage as UsageLike | undefined;
        if (eventUsage && typeof eventUsage === "object") {
          const normalized = normalizeUsage(eventUsage);
          if (normalized) {
            // Accumulate usage - take the largest values seen (final usage includes totals)
            accumulatedUsage = {
              input: Math.max(accumulatedUsage?.input ?? 0, normalized.input ?? 0) || undefined,
              output: Math.max(accumulatedUsage?.output ?? 0, normalized.output ?? 0) || undefined,
              cacheRead:
                Math.max(accumulatedUsage?.cacheRead ?? 0, normalized.cacheRead ?? 0) || undefined,
              cacheWrite:
                Math.max(accumulatedUsage?.cacheWrite ?? 0, normalized.cacheWrite ?? 0) ||
                undefined,
              total: Math.max(accumulatedUsage?.total ?? 0, normalized.total ?? 0) || undefined,
            };
            log.trace(
              `Accumulated usage: input=${accumulatedUsage.input} output=${accumulatedUsage.output}`,
            );
          }
        }
      }

      // Handle compact_boundary events — SDK emits these after compaction completes.
      // This allows us to emit a Pi Agent-compatible "compaction end" event.
      if (isRecord(event) && event.type === "system" && event.subtype === "compact_boundary") {
        const compactMeta = isRecord(event.compact_metadata) ? event.compact_metadata : undefined;
        const trigger = typeof compactMeta?.trigger === "string" ? compactMeta.trigger : "auto";
        const preTokens =
          typeof compactMeta?.pre_tokens === "number" ? compactMeta.pre_tokens : undefined;

        log.debug(
          `Compaction completed: trigger=${trigger}` +
            (preTokens !== undefined ? `, pre_tokens=${preTokens}` : ""),
        );

        // Emit compaction end event matching Pi Agent's format
        // (stream: "compaction", data: { phase: "end", willRetry: false })
        emitEvent("compaction", {
          phase: "end",
          trigger,
          preTokens,
          willRetry: false, // SDK doesn't expose retry info
          source: "claude-agent-sdk",
        });
      }

      const { kind } = classifyEvent(event);

      // Emit tool results via callback.
      if (!hooksEnabled && kind === "tool") {
        const record = isRecord(event) ? event : undefined;
        const type = record && typeof record.type === "string" ? record.type : undefined;
        const phase = (() => {
          if (type === "tool_execution_start" || type === "tool_use") {
            return "start";
          }
          if (isSdkTerminalToolEventType(type)) {
            return "result";
          }
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
            const record = isRecord(event) ? event : undefined;
            const type = record && typeof record.type === "string" ? record.type : "";
            if (isSdkTerminalToolEventType(type)) {
              await params.onToolResult({ text: toolText });
            }
          } catch {
            // Don't break the stream on callback errors.
          }
        }
      }

      // Emit system/lifecycle events.
      if (kind === "system" && isRecord(event)) {
        emitEvent("sdk", event);
      }

      // Handle terminal result event.
      if (kind === "result" && isRecord(event)) {
        const result = event.result;
        if (typeof result === "string") {
          resultText = result;
        }
        // Extract session ID for native session resume on next query.
        const sessionId = event.session_id ?? event.sessionId;
        if (typeof sessionId === "string" && sessionId) {
          returnedSessionId = sessionId;
          log.trace(`SDK returned session ID: ${sessionId}`);
        }
        // Also check for error results.
        const subtype = event.subtype;
        if (subtype === "error" && typeof event.error === "string") {
          log.warn(`SDK returned error result: ${event.error}`);
        }
        break;
      }

      // Also check for session ID in system events (some SDK versions emit it early).
      if (kind === "system" && isRecord(event) && !returnedSessionId) {
        const sessionId = event.session_id ?? event.sessionId;
        if (typeof sessionId === "string" && sessionId) {
          returnedSessionId = sessionId;
          log.trace(`SDK session ID from system event: ${sessionId}`);
        }
      }

      // Extract text from assistant messages.
      if (kind === "assistant" || kind === "unknown") {
        const text = extractTextFromClaudeAgentSdkEvent(event);
        if (!text) {
          continue;
        }

        const trimmed = text.trimEnd();
        if (!trimmed) {
          continue;
        }

        if (!didAssistantMessageStart) {
          didAssistantMessageStart = true;
          try {
            void Promise.resolve(params.onAssistantMessageStart?.()).catch((err) => {
              log.trace(`onAssistantMessageStart callback error: ${String(err)}`);
            });
          } catch (err) {
            log.trace(`onAssistantMessageStart callback error: ${String(err)}`);
          }
        }

        // Dedup: skip if this chunk is identical to or a suffix of the last.
        const last = chunks.at(-1);
        if (last && (last === trimmed || last.endsWith(trimmed))) {
          continue;
        }

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
          log.trace(`Truncated after ${extractedChars} chars`);
          break;
        }
      }
    }

    log.debug(
      `Event stream completed: events=${eventCount} extractedChars=${extractedChars} truncated=${truncated} aborted=${aborted}`,
    );
  } catch (err) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Event stream threw: ${message}`);

    // Check if this was a timeout.
    if (timeoutController.signal.aborted && !params.abortSignal?.aborted) {
      log.warn(`Timed out after ${params.timeoutMs}ms`);
      emitEvent("lifecycle", {
        phase: "error",
        startedAt,
        endedAt: Date.now(),
        runtime: "claude",
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
          provider: params.provider?.name,
          eventCount,
          extractedChars,
          truncated,
          aborted: true,
          error: { kind: "timeout", message },
          usage: accumulatedUsage,
          turnCount: turnCount > 0 ? turnCount : undefined,
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
      log.error(`Query failed: ${message}`);
      emitEvent("lifecycle", {
        phase: "error",
        startedAt,
        endedAt: Date.now(),
        runtime: "claude",
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
          provider: params.provider?.name,
          eventCount,
          extractedChars,
          truncated,
          error: { kind: "run_failed", message },
          usage: accumulatedUsage,
          turnCount: turnCount > 0 ? turnCount : undefined,
          bridge: {
            toolCount: bridgeResult.toolCount,
            registeredTools: bridgeResult.registeredTools,
            skippedTools: bridgeResult.skippedTools,
          },
        },
      };
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Build result
  // -------------------------------------------------------------------------

  log.trace(
    `Building result: resultText=${resultText?.length ?? 0} chars, chunks=${chunks.length}, aborted=${aborted}`,
  );

  const text = (resultText ?? chunks.join("\n\n")).trim();

  if (!text) {
    log.warn("No text output after stream — returning error");
    emitEvent("lifecycle", {
      phase: "error",
      startedAt,
      endedAt: Date.now(),
      runtime: "claude",
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
        provider: params.provider?.name,
        eventCount,
        extractedChars: 0,
        truncated: false,
        aborted,
        error: aborted ? undefined : { kind: "no_output", message: "No text output" },
        usage: accumulatedUsage,
        turnCount: turnCount > 0 ? turnCount : undefined,
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

  emitEvent("sdk", {
    type: "sdk_runner_end",
    eventCount,
    extractedChars,
    truncated,
    aborted,
    durationMs: Date.now() - startedAt,
    usage: accumulatedUsage,
    turnCount: turnCount > 0 ? turnCount : undefined,
  });
  emitEvent("lifecycle", {
    phase: "end",
    startedAt,
    endedAt: Date.now(),
    runtime: "claude",
    aborted,
    truncated,
    usage: accumulatedUsage,
    turnCount: turnCount > 0 ? turnCount : undefined,
  });

  // Log usage summary if available - this is the key session end log
  const usageLog = accumulatedUsage
    ? ` usage=[in=${accumulatedUsage.input ?? 0} out=${accumulatedUsage.output ?? 0}]`
    : "";
  log.info(
    `Run complete: durationMs=${Date.now() - startedAt} finalTextLen=${finalText.length} turns=${turnCount}${usageLog}`,
  );

  return {
    payloads: [{ text: finalText }],
    meta: {
      durationMs: Date.now() - startedAt,
      provider: params.provider?.name,
      eventCount,
      extractedChars,
      truncated,
      aborted,
      claudeSessionId: returnedSessionId,
      usage: accumulatedUsage,
      turnCount: turnCount > 0 ? turnCount : undefined,
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
