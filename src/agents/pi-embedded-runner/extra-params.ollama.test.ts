import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

describe("extra-params: Ollama thinking payload compatibility", () => {
  it("injects think=false when thinkingLevel is off", () => {
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
        messages: [],
        options: {
          num_ctx: 65536,
        },
      },
    }).payload as {
      options?: Record<string, unknown>;
    };

    expect(payload.options?.think).toBe(false);
  });
});
