import { describe, expect, it } from "vitest";
import { normalizeModelForCompaction } from "./compaction.js";

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
    ...overrides,
  } as Parameters<typeof normalizeModelForCompaction>[0];
}

describe("normalizeModelForCompaction", () => {
  it("preserves model for direct Anthropic endpoint", () => {
    const model = makeModel();
    const result = normalizeModelForCompaction(model);
    expect(result).toBe(model);
    expect(result.reasoning).toBe(true);
  });

  it("preserves model when baseUrl is empty (defaults to direct)", () => {
    const model = makeModel({ baseUrl: "" });
    const result = normalizeModelForCompaction(model);
    expect(result).toBe(model);
  });

  it("preserves model when baseUrl is undefined (defaults to direct)", () => {
    const model = makeModel({ baseUrl: undefined });
    const result = normalizeModelForCompaction(model);
    expect(result).toBe(model);
  });

  it("disables reasoning for non-Anthropic proxy endpoint", () => {
    const model = makeModel({
      baseUrl: "https://gateway.portkey.ai/v1",
    });
    const result = normalizeModelForCompaction(model);
    expect(result).not.toBe(model);
    expect(result.reasoning).toBe(false);
    expect(result.id).toBe("claude-opus-4-6");
  });

  it("disables reasoning for Vertex AI endpoint", () => {
    const model = makeModel({
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
    });
    const result = normalizeModelForCompaction(model);
    expect(result.reasoning).toBe(false);
  });

  it("preserves model for non-anthropic-messages API", () => {
    const model = makeModel({
      api: "google-vertex",
      baseUrl: "https://some-proxy.example.com",
    });
    const result = normalizeModelForCompaction(model);
    expect(result).toBe(model);
    expect(result.reasoning).toBe(true);
  });

  it("preserves model for bedrock API", () => {
    const model = makeModel({
      api: "bedrock-converse-stream",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    });
    const result = normalizeModelForCompaction(model);
    expect(result).toBe(model);
  });

  it("preserves non-reasoning model unchanged", () => {
    const model = makeModel({
      reasoning: false,
      baseUrl: "https://gateway.portkey.ai/v1",
    });
    const result = normalizeModelForCompaction(model);
    expect(result).toBe(model);
    expect(result.reasoning).toBe(false);
  });

  it("rejects spoofed anthropic.com subdomain in proxy URL", () => {
    const model = makeModel({
      baseUrl: "https://anthropic.com.evil.example",
    });
    const result = normalizeModelForCompaction(model);
    expect(result).not.toBe(model);
    expect(result.reasoning).toBe(false);
  });

  it("treats malformed baseUrl as proxy", () => {
    const model = makeModel({
      baseUrl: "not-a-valid-url",
    });
    const result = normalizeModelForCompaction(model);
    expect(result).not.toBe(model);
    expect(result.reasoning).toBe(false);
  });
});
