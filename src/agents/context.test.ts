import { describe, expect, it } from "vitest";
import { lookupContextTokens } from "./context.js";

describe("lookupContextTokens", () => {
  it("returns undefined for undefined modelId", () => {
    expect(lookupContextTokens(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(lookupContextTokens("")).toBeUndefined();
  });
});
