// Anthropic tests cover provider manifest model catalog behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type AnthropicManifest = {
  modelCatalog?: {
    providers?: {
      anthropic?: {
        models?: Array<{
          id?: string;
          name?: string;
          reasoning?: boolean;
          input?: string[];
          mediaInput?: {
            image?: {
              maxSidePx?: number;
              preferredSidePx?: number;
              tokenMode?: string;
            };
          };
          contextWindow?: number;
          maxTokens?: number;
        }>;
      };
    };
    discovery?: Record<string, string>;
  };
};

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as AnthropicManifest;

describe("Anthropic plugin manifest", () => {
  it("resolves both official Claude Haiku 4.5 API identifiers from the static catalog", () => {
    expect(manifest.modelCatalog?.discovery?.anthropic).toBe("static");

    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      expect(models.find((model) => model.id === id)).toEqual({
        id,
        name: "Claude Haiku 4.5",
        reasoning: true,
        input: ["text", "image"],
        mediaInput: {
          image: {
            maxSidePx: 1568,
            preferredSidePx: 1568,
            tokenMode: "provider",
          },
        },
        contextWindow: 200000,
        maxTokens: 64000,
      });
    }
  });
});
