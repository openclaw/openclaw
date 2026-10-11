import type { Model } from "@openclaw/llm-core";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { configureAiTransportHost, type AiTransportHost } from "../host.js";

export type AnthropicMessagesModel = Model<"anthropic-messages">;

function resolveTestEndpointClass(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "default";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "api.anthropic.com") {
      return "anthropic-public";
    }
    if (hostname === "openrouter.ai") {
      return "openrouter";
    }
    if (hostname === "api.xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com")) {
      return "xiaomi-native";
    }
    return "custom";
  } catch {
    return "invalid";
  }
}

export function serializeSseEvents(events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function createRawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function createSseResponse(events: Record<string, unknown>[] = []): Response {
  return createRawSseResponse(serializeSseEvents(events));
}

export function anthropicMessageStart(message: Record<string, unknown>) {
  return { type: "message_start", message };
}

export function anthropicMessageDelta(
  delta: Record<string, unknown>,
  usage?: Record<string, unknown>,
) {
  // An absent usage object serializes the event without the key, matching proxies that
  // close a turn with stop_reason alone.
  return { type: "message_delta", delta, usage };
}

export function anthropicContentBlockStart(index: number, content_block: Record<string, unknown>) {
  return { type: "content_block_start", index, content_block };
}

export function anthropicContentBlockDelta(index: number, delta: Record<string, unknown>) {
  return { type: "content_block_delta", index, delta };
}

export function makeAnthropicTransportModel(
  overrides: Partial<AnthropicMessagesModel> = {},
): AnthropicMessagesModel {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    ...overrides,
  };
}

/** Route Anthropic transport requests to a fetch mock that answers with an empty turn by default. */
export function installAnthropicTransportTestHost(params: {
  coreTransportHost: AiTransportHost;
  buildModelFetch: Mock;
  guardedFetch: Mock;
}): void {
  vi.unstubAllEnvs();
  params.buildModelFetch.mockReset();
  params.guardedFetch.mockReset();
  params.buildModelFetch.mockReturnValue(params.guardedFetch);
  configureAiTransportHost({
    ...params.coreTransportHost,
    buildModelFetch: params.buildModelFetch,
    resolveProviderRequestCapabilities: (input) => {
      const endpointClass = resolveTestEndpointClass(input.baseUrl);
      return {
        endpointClass,
        knownProviderFamily: endpointClass === "xiaomi-native" ? "xiaomi" : "",
        supportsNativeStreamingUsageCompat: false,
        supportsOpenAICompletionsStreamingUsageCompat: false,
        usesExplicitProxyLikeEndpoint: endpointClass === "custom" || endpointClass === "invalid",
        allowsAnthropicServiceTier: endpointClass === "anthropic-public",
      };
    },
  });
  params.guardedFetch.mockResolvedValue(
    createSseResponse([
      anthropicMessageStart({ id: "msg_default", usage: { input_tokens: 0, output_tokens: 0 } }),
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 0, output_tokens: 0 }),
      { type: "message_stop" },
    ]),
  );
}
