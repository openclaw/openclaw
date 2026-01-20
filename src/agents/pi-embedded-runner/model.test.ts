import { describe, expect, it } from "vitest";

import { buildInlineProviderModels } from "./model.js";

const makeModel = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
});

describe("buildInlineProviderModels", () => {
  it("attaches provider ids to inline models", () => {
    const providers = {
      " alpha ": { models: [makeModel("alpha-model")] },
      beta: { models: [makeModel("beta-model")] },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      { ...makeModel("alpha-model"), provider: "alpha" },
      { ...makeModel("beta-model"), provider: "beta" },
    ]);
  });
});
