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

  it("uses first @ after last slash for email-based auth profiles", () => {
    expect(splitTrailingAuthProfile("flash@google-gemini-cli:test@gmail.com")).toEqual({
      model: "flash",
      profile: "google-gemini-cli:test@gmail.com",
    });
  });

  it("preserves numeric version suffixes (date format)", () => {
    expect(splitTrailingAuthProfile("vertex-ai_claude-haiku-4-5@20251001")).toEqual({
      model: "vertex-ai_claude-haiku-4-5@20251001",
    });
  });

  it("preserves numeric version suffixes in custom provider models", () => {
    expect(splitTrailingAuthProfile("custom-litellm/vertex-ai_claude-haiku-4-5@20251001")).toEqual({
      model: "custom-litellm/vertex-ai_claude-haiku-4-5@20251001",
    });
  });

  it("preserves semver-like version suffixes", () => {
    expect(splitTrailingAuthProfile("provider/model@v1.2.3")).toEqual({
      model: "provider/model@v1.2.3",
    });
  });

  it("preserves numeric build number suffixes", () => {
    expect(splitTrailingAuthProfile("provider/model@1234")).toEqual({
      model: "provider/model@1234",
    });
  });

  it("preserves semver with prerelease", () => {
    expect(splitTrailingAuthProfile("provider/model@1.0.0-beta.1")).toEqual({
      model: "provider/model@1.0.0-beta.1",
    });
  });

  it("still splits non-version profile suffixes", () => {
    expect(splitTrailingAuthProfile("provider/model@work")).toEqual({
      model: "provider/model",
      profile: "work",
    });
  });

  it("still splits namespaced profile suffixes", () => {
    expect(splitTrailingAuthProfile("provider/model@cf:default")).toEqual({
      model: "provider/model",
      profile: "cf:default",
    });
  });

  it("supports auth profiles after @YYYYMMDD version suffixes", () => {
    expect(splitTrailingAuthProfile("custom/vertex-ai_claude-haiku-4-5@20251001@work")).toEqual({
      model: "custom/vertex-ai_claude-haiku-4-5@20251001",
      profile: "work",
    });
  });
});
