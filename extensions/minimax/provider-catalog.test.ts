import { describe, expect, it } from "vitest";
import { buildMinimaxPortalProvider, buildMinimaxProvider } from "./provider-catalog.js";

describe("minimax provider catalog", () => {
  it("marks MiniMax-M2.7 as image-capable in both provider catalogs", () => {
    for (const provider of [buildMinimaxProvider(), buildMinimaxPortalProvider()]) {
      expect(provider.models.find((model) => model.id === "MiniMax-M2.7")?.input).toEqual([
        "text",
        "image",
      ]);
    }
  });

  it("keeps MiniMax-M2.7-highspeed text-only", () => {
    for (const provider of [buildMinimaxProvider(), buildMinimaxPortalProvider()]) {
      expect(provider.models.find((model) => model.id === "MiniMax-M2.7-highspeed")?.input).toEqual(
        ["text"],
      );
    }
  });
});
