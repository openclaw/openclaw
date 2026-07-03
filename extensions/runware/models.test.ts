// Runware tests cover model row parsing behavior.
import { describe, expect, it } from "vitest";
import { parseRunwareModelRow } from "./models.js";

describe("parseRunwareModelRow", () => {
  it("maps a full row with image input and pricing", () => {
    const model = parseRunwareModelRow({
      id: "moonshotai-kimi-k2-6",
      name: "Kimi K2.6",
      context_length: 262144,
      max_output_tokens: 65536,
      input_modalities: ["text", "image"],
      pricing: {
        prompt: "0.0000025",
        completion: "0.00001",
        input_cache_read: "0.000001",
        input_cache_write: "0.000003",
      },
    });

    expect(model).toEqual({
      id: "moonshotai-kimi-k2-6",
      name: "Kimi K2.6",
      api: "openai-completions",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 2.5, output: 10, cacheRead: 1, cacheWrite: 3 },
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it("keeps input to text/image even when Runware advertises video/audio/file", () => {
    // The on-disk model-catalog schema (ModelCatalogInput) only accepts
    // "text" | "image" | "document" and rejects "video"/"audio" on write.
    const model = parseRunwareModelRow({
      id: "google-gemini-3-1-flash-lite",
      context_length: 1048576,
      max_output_tokens: 65536,
      input_modalities: ["text", "image", "video", "audio", "file"],
      pricing: { prompt: "0.00000025", completion: "0.0000015" },
    });
    expect(model?.input).toEqual(["text", "image"]);
  });

  it("maps a reasoning-flagged text-only row", () => {
    const model = parseRunwareModelRow({
      id: "deepseek-v4-pro",
      context_length: 163840,
      max_output_tokens: 512000,
      reasoning: true,
      pricing: { prompt: "0.000001", completion: "0.000002" },
    });

    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(["text"]);
    expect(model?.cost.cacheRead).toBe(0);
    expect(model?.cost.cacheWrite).toBe(0);
  });

  it("humanizes the id into a display name when name is missing", () => {
    const model = parseRunwareModelRow({ id: "xai-grok-4-3" });
    expect(model?.name).toBe("Xai Grok 4 3");
  });

  it("defaults sanely when context_length/max_output_tokens/pricing are null or missing", () => {
    // Real Runware rows for newly-added passthrough models ship exactly this shape.
    const model = parseRunwareModelRow({
      id: "openai-gpt-5-1",
      context_length: null,
      max_output_tokens: null,
      input_modalities: ["text"],
    });
    expect(model).toEqual({
      id: "openai-gpt-5-1",
      name: "Openai Gpt 5 1",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    });
  });

  it("returns null for rows without a usable id", () => {
    expect(parseRunwareModelRow({ name: "no id" })).toBeNull();
    expect(parseRunwareModelRow(null)).toBeNull();
    expect(parseRunwareModelRow("not-an-object")).toBeNull();
  });
});
