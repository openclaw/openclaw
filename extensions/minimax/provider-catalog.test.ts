import { describe, expect, it } from "vitest";
import { buildMinimaxPortalProvider } from "./provider-catalog.js";

describe("buildMinimaxPortalProvider", () => {
  it("includes MiniMax-M2.5-Lightning in the provider catalog", () => {
    const provider = buildMinimaxPortalProvider();
    const modelIds = provider.models.map((model) => model.id);

    expect(modelIds).toContain("MiniMax-M2.5-Lightning");
  });
});
