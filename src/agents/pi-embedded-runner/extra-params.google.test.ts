import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

describe("extra-params: Google thinking payload compatibility", () => {
  it("strips negative thinking budgets and fills Gemini 3.1 thinkingLevel", () => {
    const payload = runExtraParamsCase({
      applyProvider: "google",
      applyModelId: "gemini-3.1-pro-preview",
      model: {
        api: "google-generative-ai",
        provider: "google",
        id: "gemini-3.1-pro-preview",
      } as Model<"openai-completions">,
      thinkingLevel: "high",
      payload: {
        contents: [],
        config: {
          thinkingConfig: {
            thinkingBudget: -1,
          },
        },
      },
    }).payload as {
      config?: {
        thinkingConfig?: Record<string, unknown>;
      };
    };

    expect(payload.config?.thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(payload.config?.thinkingConfig?.thinkingLevel).toBe("HIGH");
  });
});
