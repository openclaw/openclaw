import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  findConfiguredModelMetadata,
  findModelMetadataInCatalog,
  listConfiguredModelMetadata,
  mergeModelMetadata,
} from "./model-metadata.js";

describe("model-metadata", () => {
  it("lists configured metadata with normalized providers and durable traits", () => {
    const entries = listConfiguredModelMetadata({
      models: {
        providers: {
          " Z.AI ": {
            models: [
              {
                id: "glm-5",
                input: ["text", "image", "ignored"],
                reasoning: true,
                contextWindow: 256_000,
                maxTokens: 128_000,
                cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(entries).toEqual([
      {
        provider: "zai",
        id: "glm-5",
        name: "glm-5",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 256_000,
        maxTokens: 128_000,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    ]);
  });

  it("prefers exact configured provider keys before normalized alias matches", () => {
    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": {
            models: [{ id: "claude-opus", contextWindow: 32_000 }],
          },
          bedrock: {
            models: [{ id: "claude-opus", contextWindow: 128_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      findConfiguredModelMetadata({
        cfg,
        provider: "bedrock",
        model: "claude-opus",
      })?.contextWindow,
    ).toBe(128_000);
    expect(
      findConfiguredModelMetadata({
        cfg,
        provider: "amazon-bedrock",
        model: "claude-opus",
      })?.contextWindow,
    ).toBe(32_000);
  });

  it("matches catalog entries across canonical provider aliases", () => {
    expect(
      findModelMetadataInCatalog(
        [{ provider: "z.ai", id: "GLM-5", name: "GLM-5" }],
        "z-ai",
        "glm-5",
      ),
    ).toEqual({
      provider: "z.ai",
      id: "GLM-5",
      name: "GLM-5",
    });
  });

  it("overlays configured durable traits without replacing discovered names by default", () => {
    expect(
      mergeModelMetadata(
        {
          provider: "kilocode",
          id: "kilo/auto",
          name: "Kilo Auto",
          contextWindow: 64_000,
          input: ["text"],
        },
        {
          name: "Configured Kilo Auto",
          contextWindow: 128_000,
          maxTokens: 32_000,
          reasoning: true,
          input: ["text", "image"],
        },
      ),
    ).toEqual({
      provider: "kilocode",
      id: "kilo/auto",
      name: "Kilo Auto",
      contextWindow: 128_000,
      maxTokens: 32_000,
      reasoning: true,
      input: ["text", "image"],
    });
  });
});
