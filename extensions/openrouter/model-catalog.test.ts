import { beforeEach, describe, expect, it, vi } from "vitest";

const getCachedLiveProviderModelRows = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", () => ({
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError: class LiveModelCatalogHttpError extends Error {
    status = 500;
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

import { listOpenRouterModelCatalog } from "./model-catalog.js";

describe("listOpenRouterModelCatalog", () => {
  beforeEach(() => {
    getCachedLiveProviderModelRows.mockReset();
  });

  it("projects live text-chat models with their picker metadata", async () => {
    getCachedLiveProviderModelRows.mockResolvedValueOnce([
      {
        id: "openai/gpt-5.4",
        name: "OpenAI: GPT-5.4",
        context_length: 1_050_000,
        supported_parameters: ["reasoning_effort", "tools"],
        architecture: {
          input_modalities: ["text", "image", "file"],
          output_modalities: ["text"],
        },
      },
      {
        id: "black-forest-labs/flux.2-pro",
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      },
      {
        id: "openai/gpt-5.4",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      },
    ]);

    await expect(listOpenRouterModelCatalog()).resolves.toEqual([
      {
        provider: "openrouter",
        id: "openai/gpt-5.4",
        name: "OpenAI: GPT-5.4",
        contextWindow: 1_050_000,
        reasoning: true,
        input: ["text", "image", "document"],
      },
    ]);
    expect(getCachedLiveProviderModelRows).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/models",
      }),
    );
  });

  it("returns no supplemental rows when discovery fails", async () => {
    getCachedLiveProviderModelRows.mockRejectedValueOnce(new Error("network unavailable"));

    await expect(listOpenRouterModelCatalog()).resolves.toEqual([]);
  });
});
