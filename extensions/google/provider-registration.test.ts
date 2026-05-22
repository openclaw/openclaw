import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isGoogleVertexBaseUrl, isGoogleVertexHostname } from "./provider-policy.js";
import { buildGoogleProvider } from "./provider-registration.js";

function vertexModel(
  overrides: Partial<Model<"google-generative-ai">> = {},
): Model<"google-generative-ai"> {
  return {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google-vertex",
    api: "google-generative-ai",
    input: ["text"],
    reasoning: false,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    baseUrl: "https://aiplatform.googleapis.com",
    ...overrides,
  } as Model<"google-generative-ai">;
}

function streamContext(model: Model<"google-generative-ai">) {
  return {
    provider: model.provider,
    modelId: model.id,
    model,
  } as never;
}

describe("isGoogleVertexHostname", () => {
  it("matches manifest Vertex host rules only", () => {
    expect(isGoogleVertexHostname("aiplatform.googleapis.com")).toBe(true);
    expect(isGoogleVertexHostname("us-central1-aiplatform.googleapis.com")).toBe(true);
    expect(isGoogleVertexHostname("generativelanguage.googleapis.com")).toBe(false);
    expect(isGoogleVertexHostname("evil-aiplatform.googleapis.com.attacker.com")).toBe(false);
  });
});

describe("isGoogleVertexBaseUrl", () => {
  it("does not treat proxy paths or lookalike hosts as Vertex", () => {
    expect(
      isGoogleVertexBaseUrl(
        "https://generativelanguage.googleapis.com/v1beta/proxy/aiplatform.googleapis.com",
      ),
    ).toBe(false);
    expect(isGoogleVertexBaseUrl("https://notvertex.example.com/aiplatform.googleapis.com")).toBe(
      false,
    );
    expect(isGoogleVertexBaseUrl("https://us-central1-aiplatform.googleapis.com")).toBe(true);
  });
});

describe("buildGoogleProvider createStreamFn", () => {
  it("routes google-vertex models through the Vertex transport without ADC preflight", () => {
    const provider = buildGoogleProvider();
    const model = vertexModel();
    expect(provider.createStreamFn?.(streamContext(model))).toBeTypeOf("function");
  });

  it("routes by Vertex hostname even when model api is google-generative-ai", () => {
    const provider = buildGoogleProvider();
    const model = vertexModel({
      api: "google-generative-ai",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
    });
    expect(provider.createStreamFn?.(streamContext(model))).toBeTypeOf("function");
  });

  it("keeps AI Studio models on the Generative AI transport", () => {
    const provider = buildGoogleProvider();
    const model = {
      ...vertexModel(),
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as Model<"google-generative-ai">;
    expect(provider.createStreamFn?.(streamContext(model))).toBeTypeOf("function");
  });

  it("does not route proxy base URLs with embedded Vertex strings to Vertex transport", () => {
    const proxyBaseUrl =
      "https://generativelanguage.googleapis.com/v1beta/custom/aiplatform.googleapis.com";
    expect(isGoogleVertexBaseUrl(proxyBaseUrl)).toBe(false);
    const provider = buildGoogleProvider();
    const model = {
      ...vertexModel(),
      provider: "google",
      api: "google-generative-ai",
      baseUrl: proxyBaseUrl,
    } as Model<"google-generative-ai">;
    expect(provider.createStreamFn?.(streamContext(model))).toBeTypeOf("function");
  });
});
