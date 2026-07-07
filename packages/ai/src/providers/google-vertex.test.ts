import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";
import { streamGoogleVertex } from "./google-vertex.js";

const { generateContentStreamMock, googleGenAIOptions } = vi.hoisted(() => ({
  generateContentStreamMock: vi.fn(async function* () {
    yield {
      candidates: [
        {
          content: { parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
    };
  }),
  googleGenAIOptions: [] as unknown[],
}));

vi.mock("@google/genai", () => ({
  FinishReason: { STOP: "STOP" },
  FunctionCallingConfigMode: { ANY: "ANY", AUTO: "AUTO", NONE: "NONE" },
  GoogleGenAI: vi.fn(function GoogleGenAIMock(options: unknown) {
    googleGenAIOptions.push(options);
    return {
      models: {
        generateContentStream: generateContentStreamMock,
      },
    };
  }),
  ResourceScope: { COLLECTION: "COLLECTION" },
  ThinkingLevel: {
    HIGH: "HIGH",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    MINIMAL: "MINIMAL",
    THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
  },
}));

const model = {
  id: "gemini-3.1-pro-preview",
  name: "Gemini 3.1 Pro Preview",
  api: "google-vertex",
  provider: "google",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 8_192,
} satisfies Model<"google-vertex">;

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

afterEach(() => {
  vi.unstubAllEnvs();
  generateContentStreamMock.mockClear();
  googleGenAIOptions.length = 0;
});

describe("streamGoogleVertex", () => {
  it("uses GOOGLE_CLOUD_PROJECT_ID for ADC-backed Vertex clients", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("GCLOUD_PROJECT", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT_ID", "vertex-project-id");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");

    const stream = streamGoogleVertex(model, context, { apiKey: "gcp-vertex-credentials" });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(googleGenAIOptions[0]).toMatchObject({
      apiVersion: "v1",
      location: "us-central1",
      project: "vertex-project-id",
      vertexai: true,
    });
  });

  it("prefers GCLOUD_PROJECT over GOOGLE_CLOUD_PROJECT_ID for ADC-backed Vertex clients", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("GCLOUD_PROJECT", "gcloud-project");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT_ID", "vertex-project-id");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");

    const stream = streamGoogleVertex(model, context, { apiKey: "gcp-vertex-credentials" });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(googleGenAIOptions[0]).toMatchObject({
      apiVersion: "v1",
      location: "us-central1",
      project: "gcloud-project",
      vertexai: true,
    });
  });
});
