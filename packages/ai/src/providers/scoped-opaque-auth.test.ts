import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getDefaultAiTransportHost } from "../host.js";
import { createLlmRuntime } from "../stream.js";
import type { Model } from "../types.js";
import { registerBuiltInApiProviders } from "./register-builtins.js";

const captured = vi.hoisted(() => ({ google: [] as unknown[], mistral: [] as unknown[] }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(config: unknown) {
      captured.google.push(config);
    }
    models = {
      generateContentStream: async () => {
        throw new Error("fixture constructor reached");
      },
    };
  },
  ResourceScope: { COLLECTION: "COLLECTION" },
  ThinkingLevel: {
    THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
}));
vi.mock("@mistralai/mistralai/sdk/chat", () => ({
  Chat: class {
    constructor(config: unknown) {
      captured.mistral.push(config);
    }
    async stream() {
      throw new Error("fixture constructor reached");
    }
  },
}));
const initial = getDefaultAiTransportHost();
const opaque = "prefix-oc-sent-v2." + "A".repeat(48) + ".end-suffix";
const gatewayFetch = vi.fn(() => {
  throw new Error("Gateway transport must not own this call");
});
const gatewayResolve = vi.fn(() => {
  throw new Error("Gateway auth must not own this value");
});
beforeEach(() => {
  captured.google = [];
  captured.mistral = [];
  vi.clearAllMocks();
  configureAiTransportHost({
    buildModelFetch: gatewayFetch,
    resolveSecretSentinel: gatewayResolve,
  });
});
afterEach(() => {
  configureAiTransportHost(initial);
  vi.unstubAllGlobals();
});
function model(api: string, provider: string): Model {
  return {
    id: "fixture-model",
    name: "Fixture",
    api,
    provider,
    baseUrl: "https://proxy.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}
function runtime() {
  const value = createLlmRuntime(undefined, { transportHost: {} });
  registerBuiltInApiProviders(value.registry);
  return value;
}
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };

describe("scoped native auth at provider boundaries", () => {
  it.each(["google-generative-ai", "google-vertex"])(
    "preserves external opaque values at %s SDK construction",
    async (api) => {
      const result = await runtime().completeSimple(
        {
          ...model(api, api === "google-vertex" ? "google-vertex" : "google"),
          headers: { "X-Provider-Token": opaque },
        },
        context,
        { apiKey: opaque },
      );
      expect(result.errorMessage).toContain("fixture constructor reached");
      expect(captured.google).toHaveLength(1);
      expect(captured.google[0]).toMatchObject({
        apiKey: opaque,
        httpOptions: { headers: { "X-Provider-Token": opaque } },
      });
      expect(gatewayResolve).not.toHaveBeenCalled();
      expect(gatewayFetch).not.toHaveBeenCalled();
    },
  );
  it("preserves Mistral auth while selecting the native custom-fetch owner", async () => {
    const result = await runtime().completeSimple(
      model("mistral-conversations", "mistral"),
      context,
      { apiKey: opaque },
    );
    expect(result.errorMessage).toContain("fixture constructor reached");
    expect(captured.mistral).toHaveLength(1);
    expect(captured.mistral[0]).toMatchObject({ apiKey: opaque });
    expect(gatewayResolve).not.toHaveBeenCalled();
    expect(gatewayFetch).not.toHaveBeenCalled();
  });
  it.each(["anthropic-messages", "google-interactions"])(
    "keeps %s auth opaque through every resolver stage and HTTP construction",
    async (api) => {
      const requests: Headers[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input, init).headers);
        const frames =
          api === "google-interactions"
            ? [
                {
                  event_type: "interaction.completed",
                  interaction: {
                    status: "completed",
                    usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 },
                  },
                },
              ]
            : [
                {
                  type: "message_start",
                  message: {
                    id: "fixture",
                    model: "fixture-model",
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "ok" },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 1 },
                },
                { type: "message_stop" },
              ];
        const body = frames
          .map(
            (frame) =>
              ("type" in frame ? "event: " + frame.type + "\n" : "") +
              "data: " +
              JSON.stringify(frame) +
              "\n\n",
          )
          .join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      });
      // Run twice: a warm provider module must retain each new invocation's owner too.
      const owner = runtime();
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await owner.completeSimple(
          {
            ...model(api, api === "anthropic-messages" ? "anthropic" : "google"),
            headers: { "x-custom-auth": "Bearer " + opaque },
          },
          context,
          { apiKey: opaque },
        );
        expect(result.stopReason, result.errorMessage).toBe("stop");
      }
      expect(requests).toHaveLength(2);
      for (const headers of requests) {
        expect(headers.get(api === "anthropic-messages" ? "x-api-key" : "x-goog-api-key")).toBe(
          opaque,
        );
        expect(headers.get("x-custom-auth")).toBe("Bearer " + opaque);
      }
      expect(gatewayResolve).not.toHaveBeenCalled();
      expect(gatewayFetch).not.toHaveBeenCalled();
    },
  );
});
