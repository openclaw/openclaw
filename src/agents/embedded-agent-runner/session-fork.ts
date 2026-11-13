import {
  independentResponsesRequest,
  responsesRequestLifecycle,
} from "@openclaw/ai/internal/openai";
import { uncachedSuffixMessage } from "@openclaw/ai/internal/shared";
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

// The fork denies client tool calls itself; tool_choice none is what stops provider-hosted
// tools (for example web search), which run before the fork sees them.
const FORK_TOOL_CHOICE_SHAPES = new Map<Model["api"], "object" | "string">([
  ["anthropic-messages", "object"],
  ["openai-responses", "string"],
  ["openai-chatgpt-responses", "string"],
  ["openai-completions", "string"],
]);
// Responses WebSockets check fork authority through responsesRequestLifecycle. Other
// transports must send through the host's guarded fetch, which checks it before every
// physical send, including DNS/proxy setup, retries and redirects. An egress check makes
// SDKs that otherwise choose their own fetch (Google GenAI) use the guarded one.
const RESPONSES_LIFECYCLE_APIS = new Set<Model["api"]>([
  "openai-responses",
  "openai-chatgpt-responses",
]);
// The AWS SDK sends Bedrock requests and their retries through its own HTTP handler, so
// a fork whose authority ended could still send.
const UNFENCED_FORK_APIS = new Set<Model["api"]>(["bedrock-converse-stream"]);

const TOOL_CALL_ID_KEYS = new Set(["id", "call_id", "tool_use_id", "tool_call_id"]);

/**
 * Cache checkpoints place a request rather than content; only the parent's survive replay,
 * as nothing reads one the fork writes past the parent's input. `id` maps tool-call IDs.
 */
const serializeItem = (item: unknown, id: (value: string) => unknown, textBlocks = false) =>
  JSON.stringify(item, (key, value: unknown) => {
    if (key === "cache_control") {
      return undefined;
    }
    if (typeof value === "string" && TOOL_CALL_ID_KEYS.has(key)) {
      return id(value);
    }
    return textBlocks && key === "content" && typeof value === "string"
      ? [{ type: "text", text: value }]
      : value;
  });

/**
 * The parent's stream may rewrite tool-call IDs and collapse one text block to a string
 * after the history the fork rebuilds, so items compare with IDs by order of first use.
 */
function compareItems(items: unknown[]) {
  const ids: string[] = [];
  const keys = items.map((item) =>
    serializeItem(
      item,
      (value) => (ids.includes(value) ? ids.indexOf(value) : ids.push(value) - 1),
      true,
    ),
  );
  return { ids, keys };
}

const isPlainContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  Array.isArray(value) ||
  (typeof value === "object" &&
    value !== null &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/** Signals, fetch overrides and class instances; JSON null and primitives are data. */
const isTransportHandle = (value: unknown) =>
  typeof value === "function" ||
  (typeof value === "object" && value !== null && !isPlainContainer(value));

/**
 * Copies the parent's request data. Transport handles that ride in request configs (the
 * Google SDK's abort signal, fetch overrides) belong to each request, so the fork's own
 * value at the same path replaces them.
 */
function replayData(sent: unknown, own: unknown): unknown {
  if (isTransportHandle(sent)) {
    return own;
  }
  if (!isPlainContainer(sent)) {
    return sent;
  }
  const ownRecord: Record<string, unknown> = isPlainContainer(own) ? Object(own) : {};
  if (Array.isArray(sent)) {
    return sent.map((item, index) => replayData(item, ownRecord[index]));
  }
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(sent)) {
    const replayed = replayData(value, ownRecord[name]);
    if (replayed !== undefined) {
      copy[name] = replayed;
    }
  }
  for (const [name, value] of Object.entries(ownRecord)) {
    if (!(name in copy) && isTransportHandle(value)) {
      copy[name] = value;
    }
  }
  return copy;
}

/**
 * Replays the parent's last prepared request, then the fork's own items. Its own request is
 * rebuilt from history, whose bytes and order may differ from what the parent sent. Keeps
 * the rebuilt request when the parent sent items the fork lacks or only a continuation delta.
 */
function replayPreparedRequest(
  payload: Record<string, unknown>,
  prepared: Record<string, unknown>,
): void {
  const key = ["input", "messages", "contents"].find((name) => Array.isArray(payload[name]));
  if (!key) {
    return;
  }
  const ownItems = payload[key];
  const sentItems = prepared[key];
  if (
    !Array.isArray(ownItems) ||
    !Array.isArray(sentItems) ||
    prepared.previous_response_id != null
  ) {
    return;
  }
  const parent = compareItems(sentItems);
  const own = compareItems(ownItems);
  const unmatched = new Map<string, number>();
  for (const item of parent.keys) {
    unmatched.set(item, (unmatched.get(item) ?? 0) + 1);
  }
  const suffix = ownItems.filter((_, index) => {
    const count = unmatched.get(own.keys[index]!);
    if (count) {
      unmatched.set(own.keys[index]!, count - 1);
    }
    return !count;
  });
  if ([...unmatched.values()].some(Boolean)) {
    return;
  }
  // Matched items share ID order, so the suffix spells the parent's IDs as the parent did.
  const spelling = new Map(parent.ids.map((id, index) => [own.ids[index], id]));
  const replay = replayData({ ...prepared, [key]: [] }, payload);
  for (const name of Object.keys(payload)) {
    delete payload[name];
  }
  Object.assign(payload, replay, {
    [key]: [
      ...sentItems.map((item) => replayData(item, undefined)),
      ...suffix.map((item) =>
        JSON.parse(serializeItem(item, (value) => spelling.get(value) ?? value)),
      ),
    ],
  });
}

/** Function declarations the fork can deny; anything else may run at the provider. */
function isClientTool(tool: unknown): boolean {
  if (!isRecord(tool)) {
    return false;
  }
  if (tool.type === undefined) {
    // Anthropic client tools, or a Gemini functionDeclarations group.
    return (
      "input_schema" in tool || Object.keys(tool).every((key) => key === "functionDeclarations")
    );
  }
  return tool.type === "function" || tool.type === "custom";
}

/** Prepare and run a tool-free request only when a caller actually forks. */
export async function runEmbeddedSessionFork(params: {
  context: Context;
  streamFn: StreamFn;
  options?: StreamOptions;
  /** The parent's last provider request; absent, the rebuilt request is sent unchanged. */
  preparedRequest?: Record<string, unknown>;
  question: string;
  model: Model;
  apiKey?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  onUsage?: (usage: NormalizedUsage | undefined) => void;
}): Promise<string> {
  if (UNFENCED_FORK_APIS.has(params.model.api)) {
    throw new Error(
      `Session forks do not support provider API ${params.model.api}: its transport cannot enforce live fork authority.`,
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
  // The session already cached the input of its latest response. Its next call sends and
  // writes what follows itself, beside this fork, and nothing reads the fork's question.
  const latestResponse = context.messages.findLastIndex((message) => message.role === "assistant");
  if (latestResponse >= 0) {
    for (let index = latestResponse + 1; index < context.messages.length; index++) {
      context.messages[index] = uncachedSuffixMessage.mark({ ...context.messages[index]! });
    }
  }
  context.messages.push(
    uncachedSuffixMessage.mark({ role: "user", content: params.question, timestamp: Date.now() }),
  );
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
        if (params.preparedRequest) {
          replayPreparedRequest(payload, params.preparedRequest);
        }
        // Mutate the prepared body: provider wrappers reapply their defaults to
        // replacement objects, but preserve an in-place caller override.
        const toolChoiceShape = FORK_TOOL_CHOICE_SHAPES.get(model.api);
        if (!toolChoiceShape) {
          // Gemini SDK requests carry tools in config.
          const tools = [payload.tools, isRecord(payload.config) && payload.config.tools];
          if (!tools.every((list) => !Array.isArray(list) || list.every(isClientTool))) {
            throw new Error(
              `Session forks cannot disable provider-hosted tools on provider API ${model.api}. Remove hosted tools from this model's requests to fork it.`,
            );
          }
        } else if (Array.isArray(payload.tools) && payload.tools.length > 0) {
          payload.tool_choice = toolChoiceShape === "object" ? { type: "none" } : "none";
        } else {
          delete payload.tool_choice;
        }
        delete payload.previous_response_id;
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
    const result = await withGuardedFetchRequestAuthority(
      assertCurrent,
      async () => {
        const stream = await params.streamFn(model, context, options);
        assertCurrent();
        return await stream.result();
      },
      RESPONSES_LIFECYCLE_APIS.has(model.api) ? undefined : assertCurrent,
    );
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
