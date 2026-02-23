import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveForwardCompatModel } from "./model-forward-compat.js";
import type { ModelRegistry } from "./pi-model-discovery.js";

function makeRegistry(): ModelRegistry {
  const templates = new Map<string, Model<Api>>();
  templates.set("google-antigravity/gemini-3-pro-high", {
    id: "gemini-3-pro-high",
    name: "Gemini 3 Pro High",
    provider: "google-antigravity",
    api: "google-antigravity",
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: true,
  } as Model<Api>);
  templates.set("google-antigravity/gemini-3-pro-low", {
    id: "gemini-3-pro-low",
    name: "Gemini 3 Pro Low",
    provider: "google-antigravity",
    api: "google-antigravity",
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: true,
  } as Model<Api>);

  const registry = {
    find: (provider: string, modelId: string) => templates.get(`${provider}/${modelId}`) ?? null,
  } as unknown as ModelRegistry;
  return registry;
}

describe("resolveForwardCompatModel (google-antigravity Gemini 3.1)", () => {
  it("resolves gemini-3-1-pro-high from gemini-3-pro-high template", () => {
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3-1-pro-high",
      makeRegistry(),
    );
    expect(model?.provider).toBe("google-antigravity");
    expect(model?.id).toBe("gemini-3-1-pro-high");
  });

  it("resolves gemini-3-1-pro-low from gemini-3-pro-low template", () => {
    const model = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3-1-pro-low",
      makeRegistry(),
    );
    expect(model?.provider).toBe("google-antigravity");
    expect(model?.id).toBe("gemini-3-1-pro-low");
  });

  it("supports dot-notation model ids", () => {
    const high = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-pro-high",
      makeRegistry(),
    );
    const low = resolveForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-pro-low",
      makeRegistry(),
    );
    expect(high?.id).toBe("gemini-3.1-pro-high");
    expect(low?.id).toBe("gemini-3.1-pro-low");
  });
});
