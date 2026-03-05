/**
 * Iris Engine — Parallel Agent Loop
 *
 * Drop-in replacement for @mariozechner/pi-agent-core's agent-loop.
 *
 * KEY DIFFERENCE: executeToolCallsParallel runs all tool calls concurrently
 * via Promise.allSettled instead of sequentially. With N tools each taking
 * T ms, latency drops from N×T to max(T).
 *
 * Steering-message semantics are preserved: user interrupt is checked before
 * the parallel batch starts so the user can still cancel before any work begins.
 */

import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import { EventStream, streamSimple, validateToolArguments } from "@mariozechner/pi-ai";
import {
  charsToTokens,
  compressAgedToolResults,
  estimateMessageChars,
} from "./context-compressor.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "./types.js";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start an agent loop with a new prompt message.
 * Identical signature to pi-agent-core's agentLoop — drop-in replacement.
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();
  void (async () => {
    const newMessages = [...prompts];
    const currentContext: AgentContext = {
      ...context,
      messages: [...context.messages, ...prompts],
    };
    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });
    for (const prompt of prompts) {
      stream.push({ type: "message_start", message: prompt });
      stream.push({ type: "message_end", message: prompt });
    }
    await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
  })();
  return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Identical signature to pi-agent-core's agentLoopContinue.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }
  const stream = createAgentStream();
  void (async () => {
    const newMessages: AgentMessage[] = [];
    const currentContext = { ...context };
    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });
    await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
  })();
  return stream;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Simple counting semaphore for capping parallel tool executions.
 * acquire() resolves immediately when a slot is free, otherwise queues.
 * release() unblocks the next waiter (or increments the slot count).
 */
class Semaphore {
  private slots: number;
  private readonly queue: (() => void)[] = [];
  constructor(limit: number) {
    this.slots = limit;
  }
  acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return Promise.resolve();
    }
    return new Promise((r) => this.queue.push(r));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.slots++;
    }
  }
}

/** Stable JSON serialisation (sorted keys) for use as cache keys. */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(stableJson).join(",")}]`;
  }
  const pairs = Object.keys(v as Record<string, unknown>)
    .toSorted()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`);
  return `{${pairs.join(",")}}`;
}

function toolCacheKey(toolName: string, args: unknown): string {
  return `${toolName}\x00${stableJson(args)}`;
}

/** Combine parent signal + optional per-tool timeout into one AbortSignal. */
function makeToolSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (parent) {
    signals.push(parent);
  }
  if (timeoutMs && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signals.length === 0) {
    return undefined;
  }
  if (signals.length === 1) {
    return signals[0];
  }
  return AbortSignal.any(signals);
}

type CacheEntry = { result: AgentToolResult<unknown>; ts: number };
type ToolCache = Map<string, CacheEntry>;

type SessionTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Log per-turn and cumulative token usage to stderr. */
function logTokenUsage(message: AssistantMessage, session: SessionTokens): void {
  const u = message.usage;
  if (!u) {
    return;
  }
  session.input += u.input ?? 0;
  session.output += u.output ?? 0;
  session.cacheRead += u.cacheRead ?? 0;
  session.cacheWrite += u.cacheWrite ?? 0;
  const totalCost = u.cost?.total ?? 0;
  const sessionTotal = session.input + session.output + session.cacheRead + session.cacheWrite;
  process.stderr.write(
    `[iris-tokens] turn in=${u.input} out=${u.output}` +
      (u.cacheRead ? ` cacheRead=${u.cacheRead}` : "") +
      (u.cacheWrite ? ` cacheWrite=${u.cacheWrite}` : "") +
      (totalCost > 0 ? ` cost=$${totalCost.toFixed(4)}` : "") +
      ` | session total=${sessionTotal}\n`,
  );
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );
}

async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: StreamFn,
): Promise<void> {
  let firstTurn = true;
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];
  // One cache per agent run; shared across all parallel batches.
  const toolCache: ToolCache = new Map();
  // Accumulate token usage across all turns in this agent run.
  const sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  while (true) {
    let hasMoreToolCalls = true;
    let steeringAfterTools: AgentMessage[] | null = null;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        stream.push({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          stream.push({ type: "message_start", message });
          stream.push({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        stream,
        streamFn,
      );
      newMessages.push(message);
      logTokenUsage(message, sessionTokens);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "turn_end", message, toolResults: [] });
        stream.push({ type: "agent_end", messages: newMessages });
        stream.end(newMessages);
        return;
      }

      const toolCalls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;
      const toolResults: AgentMessage[] = [];

      if (hasMoreToolCalls) {
        // ← PARALLEL execution (with timeout, cache, dedup)
        const toolExecution = await executeToolCallsParallel(
          currentContext.tools,
          message,
          signal,
          stream,
          config.getSteeringMessages,
          {
            toolTimeoutMs: config.toolTimeoutMs,
            toolCacheMs: config.toolCacheMs,
            toolCache,
            maxParallelTools: config.maxParallelTools,
          },
        );
        toolResults.push(...toolExecution.toolResults);
        steeringAfterTools = toolExecution.steeringMessages ?? null;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      // toolResults cast: AgentEvent turn_end expects ToolResultMessage[],
      // which is a subset of AgentMessage[] that we know we have here.
      stream.push({
        type: "turn_end",
        message,
        toolResults: toolResults as Parameters<(typeof stream)["push"]>[0] extends {
          type: "turn_end";
          toolResults: infer R;
        }
          ? R
          : never,
      });

      if (steeringAfterTools && steeringAfterTools.length > 0) {
        pendingMessages = steeringAfterTools;
        steeringAfterTools = null;
      } else {
        pendingMessages = (await config.getSteeringMessages?.()) ?? [];
      }
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }
    break;
  }

  stream.push({ type: "agent_end", messages: newMessages });
  stream.end(newMessages);
}

/** Log compression savings to stderr. Only emits when something was actually compressed. */
function logCompressionStats(beforeChars: number, afterChars: number): void {
  const savedChars = beforeChars - afterChars;
  if (savedChars <= 0) {
    return;
  }
  const pct = Math.round((savedChars / beforeChars) * 100);
  const savedTokens = charsToTokens(savedChars);
  process.stderr.write(
    `[iris-compress] before=${beforeChars}ch after=${afterChars}ch` +
      ` saved=${savedChars}ch (~${savedTokens}tok, ${pct}%)\n`,
  );
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: StreamFn,
): Promise<AssistantMessage> {
  let messages = context.messages;
  if (config.toolResultCompression !== false) {
    const opts = config.toolResultCompression ?? {
      ageTurns: 2,
      maxChars: 100,
      maxAssistantChars: 300,
    };
    const beforeChars = estimateMessageChars(messages);
    messages = compressAgedToolResults(messages, opts);
    logCompressionStats(beforeChars, estimateMessageChars(messages));
  }
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  const llmMessages = await config.convertToLlm(messages);
  const llmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction = streamFn ?? streamSimple;
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) ?? config.apiKey;
  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        stream.push({ type: "message_start", message: { ...partialMessage } });
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          stream.push({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;
      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          stream.push({ type: "message_start", message: { ...finalMessage } });
        }
        stream.push({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }
  return response.result();
}

// ─── PARALLEL tool execution ──────────────────────────────────────────────────

/**
 * Execute all tool calls in parallel using Promise.allSettled.
 *
 * Sequential (before):  tool1 → wait → tool2 → wait → tool3 → wait  (N × T)
 * Parallel  (after):    tool1 ┐
 *                       tool2 ├→ wait for slowest → done              (max T)
 *                       tool3 ┘
 *
 * Steering messages are checked BEFORE launching the batch so the user can
 * still interrupt before any work begins. If the agent is mid-batch and the
 * user sends a message, it will be picked up on the next turn.
 */
async function executeToolCallsParallel(
  tools: AgentTool[] | undefined,
  assistantMessage: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  getSteeringMessages?: () => Promise<AgentMessage[]>,
  opts?: {
    toolTimeoutMs?: number;
    toolCacheMs?: number;
    toolCache?: ToolCache;
    maxParallelTools?: number;
  },
): Promise<{ toolResults: AgentMessage[]; steeringMessages?: AgentMessage[] }> {
  const toolCalls = assistantMessage.content.filter((c): c is ToolCall => c.type === "toolCall");

  if (toolCalls.length === 0) {
    return { toolResults: [] };
  }

  // Check for user interrupt BEFORE starting — preserves steering semantics.
  if (getSteeringMessages) {
    const steering = await getSteeringMessages();
    if (steering.length > 0) {
      const skipped = toolCalls.map((tc) => skipToolCall(tc, stream));
      return { toolResults: skipped, steeringMessages: steering };
    }
  }

  // Emit execution_start for ALL tools immediately so the UI shows
  // all of them as "in progress" at once.
  for (const toolCall of toolCalls) {
    stream.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
  }

  const { toolTimeoutMs, toolCacheMs, toolCache, maxParallelTools } = opts ?? {};
  // Default to 5; use a large number to effectively disable.
  const sem = new Semaphore(maxParallelTools ?? 5);

  // Per-tool durations for observability (sequential-equivalent estimate).
  // Cache hits get duration=0 (they're instant).
  const toolDurations: number[] = Array.from({ length: toolCalls.length }, () => 0);
  let cacheHits = 0;

  // Within-batch dedup: same (name, args) key shares one Promise so the tool
  // executes only once even if the LLM requested it multiple times in one turn.
  const batchPromises = new Map<string, Promise<AgentToolResult<unknown>>>();

  // Launch every tool concurrently.
  const batchStart = Date.now();
  const executions = toolCalls.map(async (toolCall, i) => {
    const tool = tools?.find((t) => t.name === toolCall.name);
    if (!tool) {
      throw new Error(`Tool ${toolCall.name} not found`);
    }

    const cacheKey = toolCacheKey(toolCall.name, toolCall.arguments);

    // ── Cross-turn cache hit ──────────────────────────────────────────────────
    if (tool.cacheable && toolCache && toolCacheMs) {
      const entry = toolCache.get(cacheKey);
      const maxAge = toolCacheMs === -1 ? Infinity : toolCacheMs;
      if (entry && Date.now() - entry.ts <= maxAge) {
        cacheHits++;
        return entry.result;
      }
    }

    // ── Within-batch dedup ────────────────────────────────────────────────────
    // If another slot in this batch is already running the same (name, args),
    // share its Promise rather than launching a duplicate execution.
    const existing = batchPromises.get(cacheKey);
    if (existing) {
      return existing;
    }

    // validateToolArguments narrows to the tool's specific parameter schema.
    const validatedArgs = validateToolArguments(
      tool as Parameters<typeof validateToolArguments>[0],
      toolCall,
    );

    const toolSignal = makeToolSignal(signal, toolTimeoutMs);

    const promise = (async () => {
      await sem.acquire();
      const toolStart = Date.now();
      try {
        const result = await tool.execute(
          toolCall.id,
          validatedArgs,
          toolSignal,
          (partialResult: AgentToolResult<unknown>) => {
            // Partial updates stream naturally — interleaved across tools is fine.
            stream.push({
              type: "tool_execution_update",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: toolCall.arguments,
              partialResult,
            });
          },
        );

        // Store in cross-turn cache on success (cacheable tools only).
        if (tool.cacheable && toolCache && toolCacheMs) {
          toolCache.set(cacheKey, { result, ts: Date.now() });
        }

        return result;
      } finally {
        toolDurations[i] = Date.now() - toolStart;
        sem.release();
      }
    })();

    batchPromises.set(cacheKey, promise);
    return promise;
  });

  // Wait for every tool (allSettled never throws).
  const settled = await Promise.allSettled(executions);
  const wall = Date.now() - batchStart;

  // Log parallel execution stats to stderr.
  // Always emitted when N > 1 (the interesting case); set IRIS_PARALLEL_STATS=always to
  // include single-tool calls too (useful for baselining).
  const logSingle = process.env["IRIS_PARALLEL_STATS"] === "always";
  if (toolCalls.length > 1 || logSingle) {
    const seqEstimate = toolDurations.reduce((a, b) => a + b, 0);
    const saved = seqEstimate - wall;
    const names = toolCalls.map((tc) => tc.name).join(",");
    const cacheStr = cacheHits > 0 ? ` cached=${cacheHits}` : "";
    const limit = maxParallelTools ?? 5;
    process.stderr.write(
      `[iris-parallel] n=${toolCalls.length} wall=${wall}ms seq_est=${seqEstimate}ms saved=${saved}ms${cacheStr} limit=${limit} tools=[${names}]\n`,
    );
  }

  // Emit execution_end events and collect toolResult messages in original order.
  const results: AgentMessage[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    const outcome = settled[i];
    const isError = outcome.status === "rejected";
    const result: AgentToolResult<unknown> = isError
      ? {
          content: [
            {
              type: "text",
              text:
                outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
            },
          ],
          details: {},
        }
      : outcome.value;

    stream.push({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError,
    });

    const toolResultMessage: AgentMessage = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    } as AgentMessage;

    results.push(toolResultMessage);
    stream.push({ type: "message_start", message: toolResultMessage });
    stream.push({ type: "message_end", message: toolResultMessage });
  }

  return { toolResults: results };
}

function skipToolCall(
  toolCall: ToolCall,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): AgentMessage {
  const result: AgentToolResult<unknown> = {
    content: [{ type: "text", text: "Skipped due to queued user message." }],
    details: {},
  };
  stream.push({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
  stream.push({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError: true,
  });
  const msg: AgentMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: {},
    isError: true,
    timestamp: Date.now(),
  } as AgentMessage;
  stream.push({ type: "message_start", message: msg });
  stream.push({ type: "message_end", message: msg });
  return msg;
}
