import { describe, expect, it } from "vitest";
import { resolveLlmCallAuthInfo } from "./auth-attribution.js";

describe("resolveLlmCallAuthInfo", () => {
  it("classifies oauth profiles as oauth", () => {
    expect(
      resolveLlmCallAuthInfo({
        provider: "openai",
        resolvedAuth: {
          mode: "oauth",
          profileId: "openai:work",
          source: "profile:openai:work",
        },
      }),
    ).toEqual({
      method: "oauth",
      profileId: "openai:work",
      profileType: "oauth",
      source: "auth_profile",
    });
  });

  it("classifies bearer token auth as api_key", () => {
    expect(
      resolveLlmCallAuthInfo({
        provider: "github-copilot",
        resolvedAuth: {
          mode: "token",
          profileId: "github-copilot:default",
          source: "profile:github-copilot:default",
        },
      }),
    ).toEqual({
      method: "api_key",
      profileId: "github-copilot:default",
      profileType: "token",
      source: "auth_profile",
    });
  });

  it("classifies local no-auth providers as none", () => {
    expect(
      resolveLlmCallAuthInfo({
        provider: "ollama",
        resolvedAuth: {
          mode: "api-key",
          source: "env: OLLAMA_API_KEY",
        },
      }),
    ).toEqual({
      method: "none",
      source: "none",
    });
  });

  it("returns unknown when auth metadata is missing", () => {
    expect(
      resolveLlmCallAuthInfo({
        provider: "openai",
        resolvedAuth: {
          mode: "api-key",
          source: "",
        },
      }),
    ).toEqual({
      method: "unknown",
      profileType: "api_key",
      source: "unknown",
    });
  });
});
