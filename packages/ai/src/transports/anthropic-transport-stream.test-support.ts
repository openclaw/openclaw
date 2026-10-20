import type { Model } from "@openclaw/llm-core";
import { vi, type Mock } from "vitest";
import { configureAiTransportHost, type AiTransportHost } from "../host.js";
import { anthropicModel } from "../provider-transport-parity.test-support.js";

export type AnthropicMessagesModel = Model<"anthropic-messages">;
type Wire = Record<string, unknown>;

function resolveTestEndpointClass(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "default";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.toLowerCase();
    const known = new Map([
      ["api.anthropic.com", "anthropic-public"],
      ["openrouter.ai", "openrouter"],
    ]);
    return (
      known.get(hostname) ?? (hostname.endsWith(".xiaomimimo.com") ? "xiaomi-native" : "custom")
    );
  } catch {
    return "invalid";
  }
}

export function serializeSseEvents(events: Wire[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

export function createSseResponse(events: Wire[] = []): Response {
  return new Response(serializeSseEvents(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export const anthropicMessageStart = (message: Wire) => ({ type: "message_start", message });
const event = <T extends Wire>(type: string, fields: T) => ({ type, ...fields });

// Undefined usage is omitted on the wire, as in stop-reason-only proxy events.
export const anthropicMessageDelta = (delta: Wire, usage?: Wire) =>
  event("message_delta", { delta, usage });

export const anthropicContentBlockStart = (index: number, content_block: Wire) =>
  event("content_block_start", { index, content_block });

export const anthropicContentBlockDelta = (index: number, delta: Wire) =>
  event("content_block_delta", { index, delta });

export function makeAnthropicTransportModel(
  overrides: Partial<AnthropicMessagesModel> = {},
): AnthropicMessagesModel {
  return {
    ...anthropicModel,
    input: ["text"],
    cost: { ...anthropicModel.cost },
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
