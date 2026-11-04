import type { Model } from "openclaw/plugin-sdk/llm";
import { assert, describe, expect, it, vi } from "vitest";
import { buildGoogleProvider } from "./provider-registration.js";

const streamFns = vi.hoisted(() => ({ moduleLoads: 0, generativeAi: vi.fn(), vertex: vi.fn() }));

// mock-isolation: count lazy imports without SDK/state-worker initialization; real lifecycle is tested separately.
vi.mock("./transport-stream.js", () => {
  streamFns.moduleLoads++;
  return {
    createGoogleGenerativeAiTransportStreamFn: () => streamFns.generativeAi,
    createGoogleVertexTransportStreamFn: () => streamFns.vertex,
  };
});

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google-vertex",
    api: "google-generative-ai",
    baseUrl: "https://aiplatform.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    ...overrides,
  } as Model;
}

const provider = buildGoogleProvider();
function createStream(overrides: Partial<Model> = {}) {
  return provider.createStreamFn?.({
    provider: "google-vertex",
    modelId: "gemini-2.5-flash",
    model: model(overrides),
  } as never);
}
function normalizeVideo(overrides: Partial<Model>) {
  const entry = model({
    provider: "google",
    input: ["text", "image", "video"] as never,
    ...overrides,
  });
  return provider.normalizeResolvedModel?.({
    provider: entry.provider,
    modelId: entry.id,
    model: entry,
  } as never);
}

describe("buildGoogleProvider createStreamFn", () => {
  it("keeps transport unloaded through registration and selection until the first stream", async () => {
    const vertex = createStream();
    const generativeAi = createStream({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(
      createStream({
        api: "openai-completions",
        baseUrl:
          "https://aiplatform.googleapis.com/v1/projects/test/locations/us-central1/endpoints/openapi",
      }),
    ).toBeUndefined();
    expect.soft(streamFns.moduleLoads).toBe(0);
    assert(vertex && generativeAi, "Google registration must select both transports");
    const requestModel = model();
    const context = { messages: [] };
    await vertex(requestModel, context);
    expect(streamFns.generativeAi).not.toHaveBeenCalled();
    await generativeAi(requestModel, context);
    expect(streamFns.moduleLoads).toBe(1);
    expect(streamFns.vertex).toHaveBeenCalledExactlyOnceWith(requestModel, context);
    expect(streamFns.generativeAi).toHaveBeenCalledExactlyOnceWith(requestModel, context);
  });

  it.each([
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com", true],
    ["google/gemini-3.1-pro-preview", "https://generativelanguage.googleapis.com/v1beta", true],
    ["models/gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta/", true],
    ["gemma-4-26b-a4b-it", "https://generativelanguage.googleapis.com/v1beta", false],
    ["gemini-2.5-flash-image", "https://generativelanguage.googleapis.com/v1beta", false],
    ["gemini-2.5-flash", "https://proxy.example.test/v1beta", false],
    ["gemini-2.5-flash", "https://user@generativelanguage.googleapis.com/v1beta", false],
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta?key=x", false],
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com:8443/v1beta", false],
    ["gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta/openai", false],
  ])("normalizes native-video input for exact AI Studio route %s", (modelId, baseUrl, expected) => {
    const normalized = normalizeVideo({ id: modelId, baseUrl });

    expect(((normalized?.input ?? []) as string[]).includes("video")).toBe(expected);
  });

  it.each([
    ["google-vertex", "google-vertex"],
    ["custom-google", "google-generative-ai"],
  ] as const)("strips inherited video for %s routes", (providerId, api) => {
    const normalized = normalizeVideo({ provider: providerId, api });
    expect(normalized?.input).toEqual(["text", "image"]);
  });

  it("does not resolve AI Studio credentials for Vertex-only catalog scope", async () => {
    const resolveProviderApiKey = vi.fn();

    await expect(
      provider.catalog?.run({
        providerIds: ["google-vertex"],
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  });
});
