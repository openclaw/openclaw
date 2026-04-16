import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  getMemoryEmbeddingProvider: vi.fn(
    (id: string) =>
      ({
        id,
        defaultModel: `${id}-default`,
        transport: id === "local" ? "local" : "remote",
        supportsMultimodalEmbeddings: () => true,
        create: async () => ({ provider: null }),
      }) as const,
  ),
}));

vi.mock("../plugins/memory-embedding-provider-runtime.js", () => ({
  getMemoryEmbeddingProvider: mocks.getMemoryEmbeddingProvider,
}));

import { resolveMemorySearchConfig } from "./memory-search.js";

const asConfig = (cfg: OpenClawConfig): OpenClawConfig => cfg;

describe("resolveMemorySearchConfig runtime config forwarding", () => {
  beforeEach(() => {
    mocks.getMemoryEmbeddingProvider.mockClear();
  });

  it("passes cfg to provider and fallback resolution", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            fallback: "openai",
          },
        },
      },
    });

    resolveMemorySearchConfig(cfg, "main");

    expect(mocks.getMemoryEmbeddingProvider).toHaveBeenCalledWith("local", cfg);
    expect(mocks.getMemoryEmbeddingProvider).toHaveBeenCalledWith("openai", cfg);
  });

  it("passes cfg to multimodal provider validation", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            multimodal: {
              enabled: true,
              modalities: ["image"],
            },
          },
        },
      },
    });

    resolveMemorySearchConfig(cfg, "main");

    expect(mocks.getMemoryEmbeddingProvider).toHaveBeenCalledWith("gemini", cfg);
    expect(
      mocks.getMemoryEmbeddingProvider.mock.calls.every(([, passedCfg]) => passedCfg === cfg),
    ).toBe(true);
  });
});
