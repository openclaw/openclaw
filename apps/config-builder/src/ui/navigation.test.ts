import { describe, expect, it } from "vitest";
import { modeToHash, parseModeFromHash } from "./navigation.ts";

describe("navigation mode hash", () => {
  it("parses known hashes", () => {
    expect(parseModeFromHash("#/wizard")).toBe("wizard");
    expect(parseModeFromHash("#/explorer")).toBe("explorer");
    expect(parseModeFromHash("#/")).toBe("landing");
  });

  it("falls back to landing for unknown hash", () => {
    expect(parseModeFromHash("#/unknown")).toBe("landing");
  });

  it("builds hashes for modes", () => {
    expect(modeToHash("landing")).toBe("#/");
    expect(modeToHash("explorer")).toBe("#/explorer");
    expect(modeToHash("wizard")).toBe("#/wizard");
  });
});
