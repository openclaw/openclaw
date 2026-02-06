import { describe, expect, it } from "vitest";
import { normalizeProviderId } from "./model-selection.js";

describe("normalizeProviderId for apertis aliases", () => {
  it("normalizes 'apertis-ai' to 'apertis'", () => {
    expect(normalizeProviderId("apertis-ai")).toBe("apertis");
  });

  it("keeps 'apertis' unchanged", () => {
    expect(normalizeProviderId("apertis")).toBe("apertis");
  });
});
