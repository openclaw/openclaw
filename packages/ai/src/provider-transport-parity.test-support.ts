import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  UserMessage,
} from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import type { AnthropicOptions } from "./provider-options.js";
import { createZeroUsage } from "./usage.test-support.js";

export function textBlock(text: string, cache_control?: { type: string; ttl?: string }) {
  return { type: "text" as const, text, ...(cache_control ? { cache_control } : {}) };
}

export function userMessage(
  content: UserMessage["content"],
  overrides: Partial<UserMessage> = {},
): UserMessage {
  return { role: "user", content, timestamp: 1, ...overrides };
}

export function assistantMessage(
  model: Model,
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
    stopReason: "stop",
    usage: createZeroUsage(),
    content,
    ...overrides,
  };
}

export const anthropicModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

export const context = {
  systemPrompt: "Be exact.",
  messages: [{ role: "user", content: "Find the answer.", timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look up a value.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
} satisfies Context;

const thinkingSeed = { type: "thinking", thinking: "seed", signature: "seed-signature" };
const thinkingDelta = { type: "thinking_delta", thinking: " + thought" };
const signatureDelta = { type: "signature_delta", signature: "final-signature" };
const textSeed = { type: "text", text: "Hello" };
const textDelta = { type: "text_delta", text: " world" };

export const anthropicEvents = [
  {
    type: "message_start",
    message: {
      id: "msg_parity",
      model: "claude-sonnet-4-6-response",
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: thinkingSeed },
  { type: "content_block_delta", index: 0, delta: thinkingDelta },
  { type: "content_block_delta", index: 0, delta: signatureDelta },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: textSeed },
  { type: "content_block_delta", index: 1, delta: textDelta },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 7, output_tokens: 5 },
  },
  { type: "message_stop" },
] satisfies Record<string, unknown>[];

export function createAnthropicResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "req-parity" },
  });
}

export function registerParityHostLifecycle() {
  let initialHost: ReturnType<typeof getAiTransportHost>;

  beforeAll(() => {
    initialHost = getAiTransportHost();
  });

  afterEach(() => {
    configureAiTransportHost(initialHost);
    vi.unstubAllEnvs();
  });
}

export async function captureAnthropicExchange(
  implementation: "provider" | "transport",
  options: {
    model?: Partial<Model<"anthropic-messages">>;
    apiKey?: string;
    transportApi?: Model["api"];
    reasoning?: SimpleStreamOptions["reasoning"];
    temperature?: number;
    thinkingDisplay?: AnthropicOptions["thinkingDisplay"];
    toolChoice?: AnthropicOptions["toolChoice"];
    cacheRetention?: "short" | "long" | "none";
    events?: readonly Record<string, unknown>[];
    context?: Context;
    thinkingOverride?: { type: "disabled" } | { type: "enabled"; budget_tokens: number };
    headers?: Record<string, string>;
    cacheTtlPruning?: { tools?: { allow?: string[]; deny?: string[] } };
    anthropicServerCompaction?: boolean;
    anthropicCompactThreshold?: number;
    contextManagement?: unknown;
  } = {},
) {
  const requests: Array<{ payload: Record<string, unknown>; headers: Headers }> = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const capabilities = getAiTransportHost().resolveProviderRequestCapabilities({});
  const fetchMock: typeof fetch = async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON Anthropic request body");
    }
    const payload: unknown = JSON.parse(init.body);
    if (!isRecord(payload)) {
      throw new Error("Expected an Anthropic request object");
    }
    requests.push({ payload, headers: new Headers(init?.headers) });
    return createAnthropicResponse(options.events ?? anthropicEvents);
  };
  configureAiTransportHost({
    ...getAiTransportHost(),
    buildModelFetch: () => fetchMock,
    logInfo: (_subsystem, message) => info.push(message),
    logWarn: (_subsystem, message) => warnings.push(message),
    resolveProviderRequestCapabilities: (input) => ({
      ...capabilities,
      endpointClass:
        new URL(input.baseUrl ?? "https://api.anthropic.com").hostname === "api.anthropic.com"
          ? "anthropic-public"
          : "custom",
    }),
  });
  const model = { ...anthropicModel, ...options.model };
  const streamOptions = {
    apiKey: options.apiKey ?? "sk-test",
    reasoning: Object.hasOwn(options, "reasoning") ? options.reasoning : "low",
    temperature: options.temperature,
    thinkingDisplay: options.thinkingDisplay,
    toolChoice: options.toolChoice,
    cacheRetention: options.cacheRetention,
    headers: options.headers,
    cacheTtlPruning: options.cacheTtlPruning,
    anthropicServerCompaction: options.anthropicServerCompaction,
    anthropicCompactThreshold: options.anthropicCompactThreshold,
    onPayload: (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("Expected an Anthropic request object");
      }
      if (options.thinkingOverride) {
        payload.thinking = options.thinkingOverride;
      }
      if (options.contextManagement !== undefined) {
        payload.context_management = options.contextManagement;
      }
    },
  } as const;
  const [{ streamSimpleAnthropic }, { createAnthropicMessagesTransportStreamFn: createTransport }] =
    await Promise.all([
      import("./providers/anthropic.js"),
      import("./transports/anthropic-transport-stream.js"),
    ]);
  const requestContext = options.context ?? context;
  const stream =
    implementation === "provider"
      ? streamSimpleAnthropic(model, requestContext, streamOptions)
      : await createTransport()(
          { ...model, api: options.transportApi ?? model.api },
          requestContext,
          streamOptions,
        );
  const eventTrace = [];
  for await (const event of stream) {
    eventTrace.push(event);
  }
  return { requests, terminal: await stream.result(), eventTrace, warnings, info };
}

export async function captureAnthropicRequest(
  ...args: Parameters<typeof captureAnthropicExchange>
) {
  const { requests, terminal, warnings, info } = await captureAnthropicExchange(...args);
  expect(terminal.stopReason).toBe("stop");
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) {
    throw new Error("Expected one Anthropic request");
  }
  return { ...request, warnings, info };
}
