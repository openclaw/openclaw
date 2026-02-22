import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import type {
  CliBackendConfig,
  StreamingFormat,
  StreamingFormatText,
  StreamingFormatToolResult,
  StreamingFormatToolUse,
} from "../../config/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agent/cli-streaming");

export type CliStreamEvent = {
  type: string;
  /** Cumulative text (for text events). */
  text?: string;
  /** Incremental text delta (for text events). */
  delta?: string;
  /** Extracted media URLs (for text events). */
  mediaUrls?: string[];
  /** Tool ID. */
  id?: string;
  /** Tool name. */
  name?: string;
  /** Tool input. */
  input?: unknown;
  /** Tool use ID reference (for tool results). */
  tool_use_id?: string;
  /** Tool result content. */
  content?: unknown;
  /** Whether the tool result is an error. */
  is_error?: boolean;
  [key: string]: unknown;
};

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliStreamResult = {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
  events: CliStreamEvent[];
};

export type CliStreamParams = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  eventTypes?: string[];
  backend: CliBackendConfig;
  onEvent: (event: CliStreamEvent) => void;
};

export type MappedCliEvent = {
  stream: string;
  data: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickSessionId(
  parsed: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  const fields = backend.sessionIdFields ?? [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toUsage(raw: Record<string, unknown>, backend?: CliBackendConfig): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? (raw[key] as number) : undefined;

  const pickFirst = (keys: string[] | undefined, fallback: string[]): number | undefined => {
    const ordered = keys && keys.length > 0 ? keys : fallback;
    for (const key of ordered) {
      const value = pick(key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const fields = backend?.usageFields;
  const input = pickFirst(fields?.input, ["input_tokens", "inputTokens"]);
  const output = pickFirst(fields?.output, ["output_tokens", "outputTokens"]);
  const cacheRead = pickFirst(fields?.cacheRead, [
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cacheRead",
  ]);
  const cacheWrite = pickFirst(fields?.cacheWrite, [
    "cache_creation_input_tokens",
    "cache_write_input_tokens",
    "cacheWrite",
  ]);
  const total = pickFirst(fields?.total, ["total_tokens", "total"]);

  if (!input && !output && !cacheRead && !cacheWrite && !total) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

/** Check if an event type matches the filter (supports prefix matching with *). */
function matchesEventType(eventType: string, filters: string[]): boolean {
  for (const filter of filters) {
    if (filter === eventType) return true;
    // Support prefix matching (e.g., "item" matches "item.created", "item.completed")
    if (eventType.startsWith(`${filter}.`)) return true;
  }
  return false;
}

/** Navigate to a nested value via dot-notation path (e.g., "message.content"). */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Extract matching items from parsed event using format config. */
function extractByFormat(
  parsed: Record<string, unknown>,
  eventType: string,
  format: StreamingFormatText | StreamingFormatToolUse | StreamingFormatToolResult | undefined,
): Record<string, unknown>[] {
  if (!format) return [];

  // Check if event type matches
  if (format.eventTypes && format.eventTypes.length > 0) {
    if (!matchesEventType(eventType, format.eventTypes)) return [];
  }

  // Navigate to content via contentPath
  const content = getByPath(parsed, format.contentPath ?? "");

  // Handle array or single object
  const items = Array.isArray(content) ? content : content && isRecord(content) ? [content] : [];

  // Filter by matchType if specified
  return items.filter((item) => {
    if (!isRecord(item)) return false;
    if (!format.matchType) return true;
    return item.type === format.matchType;
  }) as Record<string, unknown>[];
}

/**
 * Run a CLI with streaming NDJSON output, parsing events line-by-line.
 * Follows the iMessage RPC client pattern for readline-based JSON parsing.
 */
export async function runCliWithStreaming(params: CliStreamParams): Promise<CliStreamResult> {
  const { command, args, cwd, env, input, timeoutMs, eventTypes, backend, onEvent } = params;
  const format = backend.streamingFormat;

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | null = null;
    let reader: Interface | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolved = false;

    const events: CliStreamEvent[] = [];
    const textParts: string[] = [];
    let accumulatedText = "";
    let previousAccumulated = "";
    let sessionId: string | undefined;
    let usage: CliUsage | undefined;
    let stderrBuffer = "";

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      reader?.close();
      reader = null;
    };

    const fail = (err: Error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
      reject(err);
    };

    const succeed = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        text: textParts.join("").trim(),
        sessionId,
        usage,
        events,
      });
    };

    // Timeout handling
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        fail(new Error(`CLI streaming timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env,
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    reader = createInterface({ input: child.stdout });

    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Log raw line (truncated for readability)
      log.info(
        `cli stream: raw line: ${trimmed.slice(0, 300)}${trimmed.length > 300 ? "..." : ""}`,
      );

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not valid JSON, skip
        log.debug(`cli stream: skipping non-JSON line: ${trimmed.slice(0, 100)}`);
        return;
      }

      if (!isRecord(parsed)) {
        log.debug(`cli stream: parsed value is not a record, skipping`);
        return;
      }

      // Always try to extract session ID and usage from any parsed object
      if (!sessionId) {
        sessionId = pickSessionId(parsed, backend);
        if (sessionId) {
          log.info(`cli stream: extracted sessionId=${sessionId}`);
        }
      }
      if (isRecord(parsed.usage)) {
        const newUsage = toUsage(parsed.usage, backend);
        if (newUsage) {
          usage = newUsage;
          log.info(`cli stream: extracted usage input=${usage.input} output=${usage.output}`);
        }
      }

      const eventType = typeof parsed.type === "string" ? parsed.type : "";
      log.info(`cli stream: eventType="${eventType}"`);

      if (!eventType) {
        // Non-typed event (e.g., final result object) - already extracted session/usage above
        log.debug(`cli stream: no event type, skipping event creation`);
        return;
      }

      // Create base event
      const event: CliStreamEvent = { type: eventType, ...parsed };
      events.push(event);
      log.info(`cli stream: created event #${events.length} type="${eventType}"`);

      // Filter events by type if specified
      const shouldEmit =
        !eventTypes || eventTypes.length === 0 || matchesEventType(eventType, eventTypes);
      log.info(
        `cli stream: shouldEmit=${shouldEmit} (filters=${JSON.stringify(eventTypes ?? [])})`,
      );

      // Config-driven extraction if format is available
      if (format) {
        // Extract text blocks
        const textBlocks = extractByFormat(parsed, eventType, format.text);
        for (const block of textBlocks) {
          const textField = format.text?.textField ?? "text";
          const newText = block[textField];
          if (typeof newText === "string" && newText) {
            textParts.push(newText);
            accumulatedText += newText;

            log.info(
              `cli stream: accumulated text chunk (${newText.length} chars): "${newText.slice(0, 100)}${newText.length > 100 ? "..." : ""}"`,
            );

            // Emit text event with cumulative + delta
            if (shouldEmit || matchesEventType("text", eventTypes ?? [])) {
              // Parse directives to match embedded flow (extracts media, cleans text)
              const { text: cleanedAccumulated, mediaUrls } = parseReplyDirectives(accumulatedText);
              const { text: cleanedPrevious } = parseReplyDirectives(previousAccumulated);
              const cleanedDelta = cleanedAccumulated.startsWith(cleanedPrevious)
                ? cleanedAccumulated.slice(cleanedPrevious.length)
                : cleanedAccumulated;
              previousAccumulated = accumulatedText;

              const textEvent: CliStreamEvent = {
                type: "text",
                text: cleanedAccumulated,
                delta: cleanedDelta,
                ...(mediaUrls?.length ? { mediaUrls } : {}),
              };
              log.info(`cli stream: emitting text event (cumulative=${cleanedAccumulated.length})`);
              try {
                onEvent(textEvent);
              } catch (err) {
                log.info(
                  `cli stream: onEvent error: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
        }

        // Extract tool use blocks
        const toolUseBlocks = extractByFormat(parsed, eventType, format.toolUse);
        for (const block of toolUseBlocks) {
          const idField = format.toolUse?.idField ?? "id";
          const nameField = format.toolUse?.nameField ?? "name";
          const inputField = format.toolUse?.inputField ?? "input";

          const toolEvent: CliStreamEvent = {
            type: "tool_use",
            id: block[idField] as string | undefined,
            name: block[nameField] as string | undefined,
            input: block[inputField],
          };
          log.info(
            `cli stream: found tool_use name="${String(toolEvent.name)}" id="${String(toolEvent.id)}"`,
          );
          if (shouldEmit || matchesEventType("tool_use", eventTypes ?? [])) {
            log.info(`cli stream: emitting tool_use event`);
            try {
              onEvent(toolEvent);
            } catch (err) {
              log.info(
                `cli stream: onEvent error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        // Extract tool result blocks
        const toolResultBlocks = extractByFormat(parsed, eventType, format.toolResult);
        for (const block of toolResultBlocks) {
          const idField = format.toolResult?.idField ?? "tool_use_id";
          const outputField = format.toolResult?.outputField ?? "content";
          const isErrorField = format.toolResult?.isErrorField;

          const toolResultEvent: CliStreamEvent = {
            type: "tool_result",
            tool_use_id: block[idField] as string | undefined,
            content: block[outputField],
            is_error: isErrorField ? (block[isErrorField] as boolean) : undefined,
          };
          log.info(`cli stream: found tool_result id="${String(toolResultEvent.tool_use_id)}"`);
          if (shouldEmit || matchesEventType("tool_result", eventTypes ?? [])) {
            log.info(`cli stream: emitting tool_result event`);
            try {
              onEvent(toolResultEvent);
            } catch (err) {
              log.info(
                `cli stream: onEvent error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      } else {
        // Fallback: legacy hardcoded text accumulation for backwards compatibility
        // Note: legacy path emits raw events, not extracted events
        accumulateLegacyText(parsed, eventType, textParts);

        // Emit raw event (original behavior)
        if (shouldEmit) {
          log.info(`cli stream: emitting raw event type="${eventType}" to onEvent callback`);
          try {
            onEvent(event);
            log.info(`cli stream: onEvent callback completed for type="${eventType}"`);
          } catch (err) {
            log.info(
              `cli stream: onEvent error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      // Handle Codex thread_id extraction (not in standard format config)
      if (
        (eventType === "turn.completed" || eventType === "thread.completed") &&
        !sessionId &&
        typeof parsed.thread_id === "string"
      ) {
        sessionId = parsed.thread_id.trim();
        log.info(`cli stream: extracted thread_id as sessionId=${sessionId}`);
      }

      // Handle result event final text (Claude CLI)
      if (eventType === "result") {
        const result = isRecord(parsed.result) ? parsed.result : parsed;
        if (typeof result.text === "string" && result.text) {
          textParts.push(result.text);
          log.info(`cli stream: accumulated result text (${result.text.length} chars)`);
        }
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (err) => {
      fail(err);
    });

    child.on("close", (code, signal) => {
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const errMsg = stderrBuffer.trim() || `CLI exited with ${reason}`;
        fail(new Error(errMsg));
        return;
      }
      succeed();
    });

    // Write stdin if provided
    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

/** Legacy text accumulation for backends without streamingFormat config. */
function accumulateLegacyText(
  parsed: Record<string, unknown>,
  eventType: string,
  textParts: string[],
): void {
  // Handle Claude CLI event types
  if (eventType === "text" || eventType === "content_block_delta") {
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (text) {
      textParts.push(text);
      log.info(
        `cli stream: accumulated text chunk (${text.length} chars): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
      );
    }
  } else if (eventType === "assistant" || eventType === "message") {
    const message = isRecord(parsed.message) ? parsed.message : parsed;
    const content = message.content;
    if (typeof content === "string") {
      textParts.push(content);
      log.info(`cli stream: accumulated assistant content (${content.length} chars)`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        const blockType = typeof block.type === "string" ? block.type : "";
        if (blockType === "text" && typeof block.text === "string") {
          textParts.push(block.text);
          log.info(`cli stream: accumulated text block (${block.text.length} chars)`);
        }
      }
    }
  }

  // Handle Codex CLI event types
  if (eventType.startsWith("item.")) {
    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item && typeof item.text === "string") {
      const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
      if (!itemType || itemType.includes("message")) {
        textParts.push(item.text);
        log.info(`cli stream: accumulated item text (${item.text.length} chars)`);
      }
    }
  }
}

/**
 * Map a CLI stream event to Clawdbot agent event data.
 * Uses config-driven extraction when available, falls back to legacy mappers.
 */
export function mapCliStreamEvent(
  event: CliStreamEvent,
  backendId: string,
  _format?: StreamingFormat,
): MappedCliEvent | null {
  log.info(`cli stream: mapCliStreamEvent called for type="${event.type}" backend="${backendId}"`);

  // For text events with cumulative text, use the embedded flow pattern
  if (event.type === "text") {
    const text = typeof event.text === "string" ? event.text : "";
    const delta = typeof event.delta === "string" ? event.delta : text;
    if (!text && !delta) return null;
    return {
      stream: "assistant",
      data: {
        text,
        delta,
        mediaUrls: event.mediaUrls?.length ? event.mediaUrls : undefined,
      },
    };
  }

  // For tool_use events
  if (event.type === "tool_use") {
    const toolName = typeof event.name === "string" ? event.name : "unknown";
    const toolId = typeof event.id === "string" ? event.id : undefined;
    return {
      stream: "tool",
      data: {
        phase: "start",
        name: toolName,
        id: toolId,
        input: event.input,
      },
    };
  }

  // For tool_result events
  if (event.type === "tool_result") {
    const toolId = typeof event.tool_use_id === "string" ? event.tool_use_id : undefined;
    return {
      stream: "tool",
      data: {
        phase: "end",
        id: toolId,
        output: event.content,
        isError: event.is_error === true,
      },
    };
  }

  // Legacy fallback for unknown event types - detect format from event type or backend name
  if (
    backendId.includes("codex") ||
    event.type.startsWith("item.") ||
    event.type.startsWith("turn.") ||
    event.type.startsWith("thread.")
  ) {
    log.info(`cli stream: using Codex mapper for legacy event`);
    return mapCodexStreamEvent(event);
  }

  log.info(`cli stream: using Claude mapper for legacy event`);
  return mapClaudeStreamEvent(event);
}

/**
 * Map a Claude CLI stream event to Clawdbot agent event data.
 * Returns null for events that should not be emitted.
 * @deprecated Use mapCliStreamEvent with streamingFormat config instead.
 */
export function mapClaudeStreamEvent(event: CliStreamEvent): MappedCliEvent | null {
  switch (event.type) {
    case "tool_use": {
      const toolName = typeof event.name === "string" ? event.name : "unknown";
      const toolId = typeof event.id === "string" ? event.id : undefined;
      return {
        stream: "tool",
        data: {
          phase: "start",
          name: toolName,
          id: toolId,
          input: event.input,
        },
      };
    }
    case "tool_result": {
      const toolId = typeof event.tool_use_id === "string" ? event.tool_use_id : undefined;
      return {
        stream: "tool",
        data: {
          phase: "end",
          id: toolId,
          output: event.content,
          isError: event.is_error === true,
        },
      };
    }
    case "text":
    case "content_block_delta": {
      const text = typeof event.text === "string" ? event.text : "";
      const delta = typeof event.delta === "string" ? event.delta : text;
      if (!text && !delta) return null;
      return {
        stream: "assistant",
        data: { text, delta },
      };
    }
    case "assistant":
    case "message": {
      // Full assistant message - typically we prefer deltas, but include for completeness
      return null; // Text is accumulated separately
    }
    case "result": {
      // Final result - don't emit as event, handled for sessionId/usage extraction
      return null;
    }
    default:
      return null;
  }
}

/**
 * Map a Codex CLI stream event to Clawdbot agent event data.
 * Returns null for events that should not be emitted.
 * @deprecated Use mapCliStreamEvent with streamingFormat config instead.
 */
export function mapCodexStreamEvent(event: CliStreamEvent): MappedCliEvent | null {
  const eventType = event.type;

  if (eventType === "item.created" || eventType === "item.started") {
    const item = isRecord(event.item) ? event.item : null;
    if (item && typeof item.type === "string" && item.type === "function_call") {
      return {
        stream: "tool",
        data: {
          phase: "start",
          name: item.name,
          id: item.id,
          input: item.arguments,
        },
      };
    }
  }

  if (eventType === "item.completed") {
    const item = isRecord(event.item) ? event.item : null;
    if (item) {
      if (typeof item.type === "string" && item.type === "function_call_output") {
        return {
          stream: "tool",
          data: {
            phase: "end",
            id: item.call_id,
            output: item.output,
          },
        };
      }
      if (
        typeof item.type === "string" &&
        item.type === "message" &&
        typeof item.text === "string"
      ) {
        return {
          stream: "assistant",
          data: { text: item.text, delta: item.text },
        };
      }
    }
  }

  if (eventType === "turn.completed" || eventType === "thread.completed") {
    // Lifecycle event, don't emit as assistant event
    return null;
  }

  return null;
}
