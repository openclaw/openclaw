import { describe, expect, it } from "vitest";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

describe("splitTrailingAuthProfile", () => {
  it("returns trimmed model when no profile suffix exists", () => {
    expect(splitTrailingAuthProfile(" openai/gpt-5 ")).toEqual({
      model: "openai/gpt-5",
    });
  });

  it("splits trailing @profile suffix", () => {
    expect(splitTrailingAuthProfile("openai/gpt-5@work")).toEqual({
      model: "openai/gpt-5",
      profile: "work",
    });
  });

  it("keeps @-prefixed path segments in model ids", () => {
    expect(splitTrailingAuthProfile("openai/@cf/openai/gpt-oss-20b")).toEqual({
      model: "openai/@cf/openai/gpt-oss-20b",
    });
  });

  it("supports trailing profile override after @-prefixed path segments", () => {
    expect(splitTrailingAuthProfile("openai/@cf/openai/gpt-oss-20b@cf:default")).toEqual({
      model: "openai/@cf/openai/gpt-oss-20b",
      profile: "cf:default",
    });
  });

  it("keeps openrouter preset paths without profile override", () => {
    expect(splitTrailingAuthProfile("openrouter/@preset/kimi-2-5")).toEqual({
      model: "openrouter/@preset/kimi-2-5",
    });
  });

  it("supports openrouter preset profile overrides", () => {
    expect(splitTrailingAuthProfile("openrouter/@preset/kimi-2-5@work")).toEqual({
      model: "openrouter/@preset/kimi-2-5",
      profile: "work",
    });
  });

  it("does not split when suffix after @ contains slash", () => {
    expect(splitTrailingAuthProfile("provider/foo@bar/baz")).toEqual({
      model: "provider/foo@bar/baz",
    });
  });
});
