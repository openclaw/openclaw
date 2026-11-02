import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { makeProviderModel } from "./provider-model.test-support.js";

const googleMockState = vi.hoisted(() => ({ configs: [] as unknown[], requests: [] as unknown[] }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContentStream: vi.fn((params: unknown) => {
        googleMockState.requests.push(params);
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      googleMockState.configs.push(config);
    }
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

import { streamGoogleVertex, streamSimpleGoogleVertex } from "./google-vertex.js";
import { streamGoogle, streamSimpleGoogle } from "./google.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;
const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
const budget2048 = { includeThoughts: true, thinkingBudget: 2048 };

const googleModel = makeProviderModel("google-generative-ai", "google", "gemini-3-flash-preview");
const vertexModel = {
  ...googleModel,
  api: "google-vertex",
  provider: "google-vertex",
  baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
} satisfies Model<"google-vertex">;

describe("Google SDK construction auth", () => {
  beforeEach(() => {
    googleMockState.configs = [];
    googleMockState.requests = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    configureAiTransportHost({});
  });

  it.each([
    ["", "v1beta"],
    ["https://generativelanguage.googleapis.com/v1beta", ""],
    ["https://proxy.example.com/google/v1alpha", ""],
    ["https://proxy.example.com/google/v1", ""],
  ])("preserves the Google API version for base URL %s", async (baseUrl, apiVersion) => {
    await streamGoogle({ ...googleModel, baseUrl }, context, { apiKey: "test-key" }).result();

    expect(googleMockState.configs).toHaveLength(1);
    expect(googleMockState.configs[0]).toMatchObject({
      httpOptions: { apiVersion, ...(baseUrl ? { baseUrl } : {}) },
    });
  });

  it("keeps Vertex on v1 without a configured endpoint", async () => {
    await streamGoogleVertex({ ...vertexModel, baseUrl: "" }, context, {
      apiKey: "test-key",
    }).result();

    expect(googleMockState.configs[0]).toMatchObject({ vertexai: true, apiVersion: "v1" });
  });

  it.each([
    ["gemini-2.5-pro", "low", 64, 2112, budget2048],
    ["gemini-2.5-pro", "off", 64, 192, { thinkingBudget: 128 }],
    ["gemini-2.5-flash", "off", 64, 64, { thinkingBudget: 0 }],
    ["gemini-2.5-pro", "low", undefined, undefined, budget2048],
    ["gemini-2.5-pro", "low", 8000, 8192, budget2048],
  ] as const)(
    "preserves nucleus sampling and the output budget at the Google SDK boundary: %s %s %s",
    async (id, reasoning, maxTokens, maxOutputTokens, thinkingConfig) => {
      configureAiTransportHost({ resolveSecretSentinel: (value) => value });
      const options = { apiKey: "test-key", reasoning, maxTokens, topP: 0.4 };
      await streamSimpleGoogle({ ...googleModel, id }, context, options).result();
      await streamSimpleGoogleVertex({ ...vertexModel, id }, context, options).result();
      expect(googleMockState.requests).toHaveLength(2);
      for (const request of googleMockState.requests) {
        const serialized = JSON.stringify(request);
        expect(JSON.parse(serialized)).toEqual({
          model: id,
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          config: {
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            topP: 0.4,
            thinkingConfig,
          },
        });
      }
    },
  );

  it("identifies OpenCode conversations without cache retention", async () => {
    await streamGoogle({ ...googleModel, baseUrl: "https://opencode.ai/zen/v1" }, context, {
      apiKey: "test",
      sessionId: "conversation-123",
      cacheRetention: "none",
    }).result();
    expect(googleMockState.configs[0]).toMatchObject({
      httpOptions: { headers: { "x-opencode-session": "conversation-123" } },
    });
  });

  it.each([
    ["Google", "Authorization", "Bearer "],
    ["Vertex", "X-Provider-Token", ""],
  ] as const)(
    "unwraps %s API-key sentinels immediately before client construction",
    async (provider, header, prefix) => {
      const buildModelFetch = vi.fn();
      const secret = `${provider.toLowerCase()}-construction-secret`;
      configureAiTransportHost({
        buildModelFetch,
        resolveSecretSentinel: (value) => value.replaceAll(sentinel, secret),
      });
      const headers = { [header]: `${prefix}${sentinel}` };
      await (
        provider === "Google"
          ? streamGoogle({ ...googleModel, headers }, context, { apiKey: sentinel })
          : streamGoogleVertex({ ...vertexModel, headers }, context, { apiKey: sentinel })
      ).result();
      expect(googleMockState.configs[0]).toMatchObject({
        apiKey: secret,
        ...(provider === "Vertex" ? { vertexai: true } : {}),
        httpOptions: { headers: { [header]: `${prefix}${secret}` } },
      });
      expect(JSON.stringify(googleMockState.configs[0])).not.toContain(sentinel);
      expect(buildModelFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["gemma-4-26b-a4b-it", "low", { includeThoughts: true, thinkingLevel: "MINIMAL" }],
    ["gemma-4-26b-a4b-it", "adaptive", { includeThoughts: true, thinkingLevel: "HIGH" }],
    ["gemini-2.5-flash-lite", "minimal", { includeThoughts: true, thinkingBudget: 512 }],
  ] as const)(
    "keeps the supported Vertex thinking policy for %s",
    async (modelId, reasoning, expectedThinking) => {
      configureAiTransportHost({ resolveSecretSentinel: (value) => value });

      await streamSimpleGoogleVertex({ ...vertexModel, id: modelId }, context, {
        apiKey: "test-vertex-key",
        reasoning: reasoning as never,
      }).result();

      expect(googleMockState.requests[0]).toMatchObject({
        config: { thinkingConfig: expectedThinking },
      });
    },
  );

  it.each([
    ["   ", "   ", "project ID"],
    [" vertex-project ", "   ", "location"],
    [" vertex-project ", " us-central1 ", undefined],
  ])("trims Vertex env configuration (%s, %s)", async (project, location, missing) => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", project);
    vi.stubEnv("GCLOUD_PROJECT", "   ");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", location);
    const result = await streamGoogleVertex(vertexModel, context).result();
    expect(result.stopReason).toBe("error");
    if (missing) {
      expect(JSON.stringify(result)).toContain(`Vertex AI requires a ${missing}`);
      expect(googleMockState.configs).toHaveLength(0);
    } else {
      expect(googleMockState.configs[0]).toMatchObject({
        vertexai: true,
        project: "vertex-project",
        location: "us-central1",
      });
    }
  });
});
