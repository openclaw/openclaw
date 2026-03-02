import { describe, expect, it } from "vitest";
import { splitModelRef } from "./model-ref.js";

describe("splitModelRef", () => {
  it("returns undefineds for missing/blank refs", () => {
    expect(splitModelRef(undefined)).toEqual({ provider: undefined, model: undefined });
    expect(splitModelRef("   ")).toEqual({ provider: undefined, model: undefined });
  });

  it("parses provider/model", () => {
    expect(splitModelRef("openai/gpt-4.1-mini")).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
  });

  it("treats single token as model-only", () => {
    expect(splitModelRef("gpt-4.1-mini")).toEqual({ provider: undefined, model: "gpt-4.1-mini" });
  });

  it("does not accept leading slash as provider/model", () => {
    expect(splitModelRef("/gpt-4.1-mini")).toEqual({ provider: undefined, model: "/gpt-4.1-mini" });
  });
});
