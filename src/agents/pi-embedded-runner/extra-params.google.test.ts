import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "./extra-params.pi-ai-mock.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", async () =>
  createPiAiStreamSimpleMock(() =>
    vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai"),
  ),
);

describe("extra-params: Google thinking payload compatibility", () => {
  it("strips negative thinking budgets and fills Gemini 3.1 thinkingLevel", () => {
    const payload = runExtraParamsCase({
      applyProvider: "google",
      applyModelId: "gemini-3.1-pro-preview",
      model: {
        api: "google-generative-ai",
        provider: "google",
        id: "gemini-3.1-pro-preview",
      } as unknown as Model<"openai-completions">,
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

  it("passes cachedContent through Google extra params", () => {
    const { options } = runExtraParamsCase({
      cfg: {
        agents: {
          defaults: {
            models: {
              "google/gemini-2.5-pro": {
                params: {
                  cachedContent: "cachedContents/test-cache",
                },
              },
            },
          },
        },
      } as never,
      applyProvider: "google",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "google-generative-ai",
        provider: "google",
        id: "gemini-2.5-pro",
      } as unknown as Model<"openai-completions">,
      payload: {
        contents: [],
      },
    });

    expect((options as { cachedContent?: string } | undefined)?.cachedContent).toBe(
      "cachedContents/test-cache",
    );
  });
});
