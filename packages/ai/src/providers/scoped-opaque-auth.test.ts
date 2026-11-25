import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getDefaultAiTransportHost,
  type AiTransportHost,
} from "../host.js";
import { createNodeLlmRuntime } from "../stream.js";
import { makeProviderModel } from "./provider-model.test-support.js";
import { frame, sseResponse } from "./provider-stream.test-support.js";
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
  expect(gatewayResolve).not.toHaveBeenCalled();
  expect(gatewayFetch).not.toHaveBeenCalled();
});
function runtime(transportHost: Partial<AiTransportHost> = {}) {
  const value = createNodeLlmRuntime(undefined, transportHost);
  registerBuiltInApiProviders(value.registry);
  return value;
}
function complete(api: string, provider: string, owner = runtime()) {
  return owner.completeSimple(
    makeProviderModel(api, provider, "fixture-model", {
      baseUrl: "https://proxy.example.test/v1",
      reasoning: false,
      headers: { "X-Provider-Token": opaque, "x-custom-auth": `Bearer ${opaque}` },
    }),
    { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    { apiKey: opaque },
  );
}
function responseFrames(api: string) {
  const usage = { input_tokens: 1, output_tokens: 0 };
  if (api === "google-interactions") {
    return [{ event_type: "interaction.completed", interaction: { status: "completed" } }];
  }
  return [
    frame("message_start", { message: { id: "fixture", model: "fixture-model", usage } }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    frame("message_stop"),
  ];
}

it.each([
  ["google-generative-ai", "google", "google"],
  ["google-vertex", "google-vertex", "google"],
  ["mistral-conversations", "mistral", "mistral"],
] as const)(
  "preserves external opaque values at %s SDK construction",
  async (api, provider, sdk) => {
    const expected =
      sdk === "google"
        ? { apiKey: opaque, httpOptions: { headers: { "X-Provider-Token": opaque } } }
        : { apiKey: opaque };
    const result = await complete(api, provider);
    expect(result.errorMessage).toContain("fixture constructor reached");
    expect(captured[sdk]).toMatchObject([expected]);
  },
);
it.each(["google-generative-ai", "google-vertex"])(
  "retains each runtime's managed fetch in the %s SDK",
  async (api) => {
    const fetchers = [vi.fn(), vi.fn()];
    for (const fetcher of fetchers) {
      const owner = runtime({
        buildModelFetch: () => fetcher as typeof fetch,
        requiresManagedTransport: () => true,
      });
      const result = await complete(api, api === "google-vertex" ? api : "google", owner);
      expect(result.errorMessage).toContain("fixture constructor reached");
    }

    expect(captured.google).toMatchObject(fetchers.map((fetch) => ({ httpOptions: { fetch } })));
  },
);
it.each(["anthropic-messages", "google-interactions"])(
  "keeps %s auth opaque through every resolver stage and HTTP construction",
  async (api) => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init).headers);
      return sseResponse(responseFrames(api));
    });
    // A warm provider module must retain each invocation's owner.
    const owner = runtime();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await complete(
        api,
        api === "anthropic-messages" ? "anthropic" : "google",
        owner,
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
  },
);
