import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, validateBaseUrl, parseModelIds, buildModelDefinition } from "./index.js";

describe("normalizeBaseUrl", () => {
  it("returns default URL for empty string", () => {
    expect(normalizeBaseUrl("")).toBe("http://localhost:3000/v1");
  });

  it("returns default URL for whitespace-only string", () => {
    expect(normalizeBaseUrl("   ")).toBe("http://localhost:3000/v1");
  });

  it("appends /v1 when URL does not end with /v1", () => {
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/v1");
  });

  it("leaves URL unchanged when it already ends with /v1", () => {
    expect(normalizeBaseUrl("http://localhost:3000/v1")).toBe("http://localhost:3000/v1");
  });

  it("strips trailing slashes before checking for /v1 suffix", () => {
    expect(normalizeBaseUrl("http://localhost:3000/v1//")).toBe("http://localhost:3000/v1");
  });

  it("strips trailing slashes from URL without /v1 and then appends /v1", () => {
    expect(normalizeBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000/v1");
  });

  it("handles HTTPS URLs", () => {
    expect(normalizeBaseUrl("https://proxy.example.com")).toBe("https://proxy.example.com/v1");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeBaseUrl("  http://localhost:8080  ")).toBe("http://localhost:8080/v1");
  });

  it("preserves custom path prefix when not already /v1", () => {
    expect(normalizeBaseUrl("http://host/api")).toBe("http://host/api/v1");
  });
});

describe("validateBaseUrl", () => {
  it("returns undefined for a valid HTTP URL", () => {
    expect(validateBaseUrl("http://localhost:3000")).toBeUndefined();
  });

  it("returns undefined for a valid HTTPS URL", () => {
    expect(validateBaseUrl("https://proxy.example.com")).toBeUndefined();
  });

  it("returns undefined for URL already ending with /v1", () => {
    expect(validateBaseUrl("http://localhost:3000/v1")).toBeUndefined();
  });

  it("returns error message for invalid URL", () => {
    expect(validateBaseUrl("not-a-url")).toBe("Enter a valid URL");
  });

  it("returns undefined for empty string (defaults to valid localhost URL)", () => {
    // Empty string normalizes to default URL which is valid
    expect(validateBaseUrl("")).toBeUndefined();
  });
});

describe("parseModelIds", () => {
  it("parses comma-separated model IDs", () => {
    expect(parseModelIds("gpt-4, claude-3, gemini-pro")).toEqual([
      "gpt-4",
      "claude-3",
      "gemini-pro",
    ]);
  });

  it("parses newline-separated model IDs", () => {
    expect(parseModelIds("gpt-4\nclaude-3\ngemini-pro")).toEqual([
      "gpt-4",
      "claude-3",
      "gemini-pro",
    ]);
  });

  it("parses mixed comma and newline separators", () => {
    expect(parseModelIds("gpt-4,claude-3\ngemini-pro")).toEqual([
      "gpt-4",
      "claude-3",
      "gemini-pro",
    ]);
  });

  it("trims whitespace from each model ID", () => {
    expect(parseModelIds("  gpt-4  ,  claude-3  ")).toEqual(["gpt-4", "claude-3"]);
  });

  it("filters out empty entries", () => {
    expect(parseModelIds("gpt-4,,claude-3")).toEqual(["gpt-4", "claude-3"]);
  });

  it("deduplicates model IDs", () => {
    expect(parseModelIds("gpt-4,gpt-4,claude-3")).toEqual(["gpt-4", "claude-3"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseModelIds("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseModelIds("   ")).toEqual([]);
  });

  it("returns single model ID for single entry", () => {
    expect(parseModelIds("gpt-4")).toEqual(["gpt-4"]);
  });
});

describe("buildModelDefinition", () => {
  it("returns a model definition with the given ID", () => {
    const def = buildModelDefinition("gpt-4");
    expect(def.id).toBe("gpt-4");
  });

  it("uses model ID as the name", () => {
    const def = buildModelDefinition("claude-opus-4.6");
    expect(def.name).toBe("claude-opus-4.6");
  });

  it("sets api to openai-completions", () => {
    const def = buildModelDefinition("any-model");
    expect(def.api).toBe("openai-completions");
  });

  it("sets reasoning to false", () => {
    const def = buildModelDefinition("any-model");
    expect(def.reasoning).toBe(false);
  });

  it("includes text and image as input modalities", () => {
    const def = buildModelDefinition("any-model");
    expect(def.input).toEqual(["text", "image"]);
  });

  it("sets all cost fields to zero", () => {
    const def = buildModelDefinition("any-model");
    expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("sets contextWindow to 128000", () => {
    const def = buildModelDefinition("any-model");
    expect(def.contextWindow).toBe(128_000);
  });

  it("sets maxTokens to 8192", () => {
    const def = buildModelDefinition("any-model");
    expect(def.maxTokens).toBe(8192);
  });
});
