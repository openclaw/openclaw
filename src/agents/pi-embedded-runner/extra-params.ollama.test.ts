import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamSimple: vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(),
    })),
  };
});

describe("extra-params: Ollama thinking payload compatibility", () => {
  it("injects top-level think=false when thinkingLevel is off", () => {
    const payload = runExtraParamsCase({
      applyProvider: "ollama",
      applyModelId: "qwen3.5:9b",
      model: {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "off",
      payload: {
        model: "qwen3.5:9b",
        messages: [],
        stream: true,
        options: {
          num_ctx: 65536,
        },
      },
    }).payload as Record<string, unknown>;

    // think must be top-level, not nested under options
    expect(payload.think).toBe(false);
    expect((payload.options as Record<string, unknown>).think).toBeUndefined();
  });

  it("does not inject think=false for non-ollama models", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "off",
      payload: {
        model: "gpt-5.4",
        messages: [],
      },
    }).payload as Record<string, unknown>;

    expect(payload.think).toBeUndefined();
  });

  it("does not inject think=false when thinkingLevel is not off", () => {
    const payload = runExtraParamsCase({
      applyProvider: "ollama",
      applyModelId: "qwen3.5:9b",
      model: {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "high",
      payload: {
        model: "qwen3.5:9b",
        messages: [],
        stream: true,
        options: {
          num_ctx: 65536,
        },
      },
    }).payload as Record<string, unknown>;

    expect(payload.think).toBeUndefined();
  });
});
