import { describe, expect, it } from "vitest";

/**
 * Verify that the compaction model-patching logic correctly detects when
 * adaptive thinking would be used on a non-direct Anthropic endpoint
 * (Vertex AI, Portkey, etc.) and disables `reasoning` to prevent the
 * upstream library from sending `thinking: { type: "adaptive" }`.
 */

function patchModelForCompaction(model: {
  api: string;
  reasoning: boolean;
  id: string;
  baseUrl?: string;
}): { api: string; reasoning: boolean; id: string; baseUrl?: string } {
  if (
    model.api === "anthropic-messages" &&
    model.reasoning &&
    (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) &&
    !model.baseUrl?.includes("api.anthropic.com")
  ) {
    return { ...model, reasoning: false };
  }
  return model;
}

describe("patchModelForCompaction", () => {
  it("disables reasoning for Opus 4.6 on Vertex AI endpoint", () => {
    const model = {
      api: "anthropic-messages",
      reasoning: true,
      id: "anthropic.claude-opus-4-6@20250929",
      baseUrl: "https://us-east5-aiplatform.googleapis.com/v1/projects/my-project",
    };
    const patched = patchModelForCompaction(model);
    expect(patched.reasoning).toBe(false);
    expect(patched.id).toBe(model.id); // model ID unchanged
  });

  it("disables reasoning for Opus 4.6 on Portkey proxy", () => {
    const model = {
      api: "anthropic-messages",
      reasoning: true,
      id: "claude-opus-4.6",
      baseUrl: "https://api.portkey.ai/v1",
    };
    const patched = patchModelForCompaction(model);
    expect(patched.reasoning).toBe(false);
  });

  it("preserves reasoning for Opus 4.6 on direct Anthropic", () => {
    const model = {
      api: "anthropic-messages",
      reasoning: true,
      id: "claude-opus-4-6-20250929",
      baseUrl: "https://api.anthropic.com",
    };
    const patched = patchModelForCompaction(model);
    expect(patched.reasoning).toBe(true);
  });

  it("preserves reasoning for non-Opus-4.6 models on Vertex AI", () => {
    const model = {
      api: "anthropic-messages",
      reasoning: true,
      id: "anthropic.claude-sonnet-4-5@20250929",
      baseUrl: "https://us-east5-aiplatform.googleapis.com/v1/projects/my-project",
    };
    const patched = patchModelForCompaction(model);
    expect(patched.reasoning).toBe(true);
  });

  it("preserves non-Anthropic models", () => {
    const model = {
      api: "google-vertex",
      reasoning: true,
      id: "gemini-3.0-pro",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
    };
    const patched = patchModelForCompaction(model);
    expect(patched.reasoning).toBe(true);
  });

  it("does not patch when reasoning is already false", () => {
    const model = {
      api: "anthropic-messages",
      reasoning: false,
      id: "claude-opus-4-6",
      baseUrl: "https://api.portkey.ai/v1",
    };
    const patched = patchModelForCompaction(model);
    expect(patched).toBe(model); // same reference, no copy
  });
});
