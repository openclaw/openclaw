import {
  independentResponsesRequest,
  responsesRequestLifecycle,
} from "@openclaw/ai/internal/openai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withGuardedFetchRequestAuthority } from "../../infra/net/fetch-request-authority.js";
import type { Context, Model } from "../../llm/types.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import type { StreamFn } from "../runtime/index.js";
import { normalizeUsage, type NormalizedUsage } from "../usage.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./usage-accumulator.js";

type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;

const FORK_TOOL_CHOICE_SHAPES = new Map<Model["api"], "object" | "string">([
  ["anthropic-messages", "object"],
  ["openai-responses", "string"],
  ["openai-chatgpt-responses", "string"],
  ["openai-completions", "string"],
]);

/** Prepare and run a tool-free request only when a caller actually forks. */
export async function runEmbeddedSessionFork(params: {
  context: Context;
  streamFn: StreamFn;
  options?: StreamOptions;
  question: string;
  model: Model;
  apiKey?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  onUsage?: (usage: NormalizedUsage | undefined) => void;
}): Promise<string> {
  if (!FORK_TOOL_CHOICE_SHAPES.has(params.model.api)) {
    throw new Error(
      `Session forks do not support provider API ${params.model.api}. Use OpenAI Responses, Chat Completions, or Anthropic Messages.`,
    );
  }
  const assertCurrent = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
  };
  assertCurrent();
  const model = params.model;
  const context: Context = { ...params.context, messages: [...params.context.messages] };
  // Pair unfinished calls before transport replay repair can mistake them for
  // aborted calls. These placeholders belong only to the fork.
  const completedCalls = new Set<string>();
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role === "toolResult") {
      completedCalls.add(message.toolCallId);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall" || completedCalls.delete(block.id)) {
          continue;
        }
        context.messages.splice(index + 1, 0, {
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [
            {
              type: "text",
              text: "This tool call is still running. Its result is not available yet.",
            },
          ],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
  }
  context.messages.push({ role: "user", content: params.question, timestamp: Date.now() });
  const usage = createUsageAccumulator();
  for (let iteration = 0; iteration < 3; iteration++) {
    assertCurrent();
    const options: StreamOptions = {
      ...params.options,
      apiKey: params.apiKey,
      signal: params.signal,
      // Background reviews cannot advertise an asynchronous tool execution capability.
      asyncToolExecution: false,
      onPayload: (payload) => {
        assertCurrent();
        if (!isRecord(payload)) {
          throw new Error("Session fork requires an object provider request.");
        }
        // Mutate the prepared body: provider wrappers reapply their defaults to
        // replacement objects, but preserve an in-place caller override.
        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
          payload.tool_choice =
            FORK_TOOL_CHOICE_SHAPES.get(model.api) === "object" ? { type: "none" } : "none";
        } else {
          delete payload.tool_choice;
        }
        delete payload.previous_response_id;
        // Reconstruction does not share the parent's one-shot request preparation.
        delete payload.prompt_cache_key;
        return payload;
      },
    };
    independentResponsesRequest.set(options);
    // Native ChatGPT WebSockets and SSE use the same send-time lifecycle owner.
    responsesRequestLifecycle.set(options, {
      assertCurrent,
      beforeDispatch: async () => assertCurrent(),
      accepted: async () => assertCurrent(),
      settle: async () => assertCurrent(),
    });
    assertCurrent();
    const result = await withGuardedFetchRequestAuthority(assertCurrent, async () => {
      const stream = await params.streamFn(model, context, options);
      assertCurrent();
      return await stream.result();
    });
    assertCurrent();
    mergeUsageIntoAccumulator(usage, normalizeUsage(result.usage));
    params.onUsage?.(toNormalizedUsage(usage));
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || "Session fork failed.");
    }
    const calls = result.content.filter((block) => block.type === "toolCall");
    if (calls.length === 0) {
      const text = collectTextContentBlocks(result.content).join("").trim();
      if (!text) {
        throw new Error("No session fork response generated.");
      }
      return text;
    }
    context.messages.push(result);
    for (const call of calls) {
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: "Tool execution denied for this side question. Answer without calling tools.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
  throw new Error(
    "Session fork kept requesting tools after three attempts. Ask a question that can be answered without tools.",
  );
}
