import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildProviderConfigModelCatalogForBrowse } from "./model-catalog-browse.js";

describe("authored model catalog inventory", () => {
  it("builds provider-config inventory independently of picker allowlists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/allowlisted": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "two",
                name: "Two",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
              {
                id: "one",
                name: "One",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    };

    expect(buildProviderConfigModelCatalogForBrowse({ cfg })).toMatchObject([
      { provider: "openai", id: "one", name: "One" },
      { provider: "openai", id: "two", name: "Two" },
    ]);
  });
});
