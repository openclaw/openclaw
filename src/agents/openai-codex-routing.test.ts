import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenAIAuthProfileProvidersForAgentRuntime,
  modelSelectionShouldEnsureCodexPlugin,
  openAIProviderUsesPiRuntimeForDirectAuthProfile,
  openAIProviderUsesCodexRuntimeByDefault,
  resolveOpenAIRuntimeProviderForPi,
} from "./openai-codex-routing.js";

describe("OpenAI Codex routing policy", () => {
  it("uses Codex by default for official OpenAI agent model selections", () => {
    expect(openAIProviderUsesCodexRuntimeByDefault({ provider: "openai" })).toBe(true);
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: {} as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("does not force Codex for custom OpenAI-compatible base URLs", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(openAIProviderUsesCodexRuntimeByDefault({ provider: "openai", config })).toBe(false);
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
  });

  it("keeps Codex as fallback for unselected OpenAI API-key profile metadata", () => {
    const config = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(openAIProviderUsesPiRuntimeForDirectAuthProfile({ provider: "openai", config })).toBe(
      false,
    );
    expect(openAIProviderUsesCodexRuntimeByDefault({ provider: "openai", config })).toBe(true);
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(true);
    expect(
      openAIProviderUsesCodexRuntimeByDefault({
        provider: "openai",
        config,
        authProfileId: "openai:default",
      }),
    ).toBe(false);
  });

  it("keeps Codex eligible when direct and Codex OpenAI profiles are both configured", () => {
    const config = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
          },
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(openAIProviderUsesCodexRuntimeByDefault({ provider: "openai", config })).toBe(true);
    expect(
      openAIProviderUsesCodexRuntimeByDefault({
        provider: "openai",
        config,
        authProfileId: "openai:default",
      }),
    ).toBe(false);
    expect(
      openAIProviderUsesCodexRuntimeByDefault({
        provider: "openai",
        config,
        authProfileId: "openai-codex:default",
      }),
    ).toBe(true);
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(true);
  });

  it("maps explicit PI plus Codex auth profile to the legacy PI Codex-auth transport", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "pi",
      }),
    ).toEqual(["openai", "openai-codex"]);
    expect(
      resolveOpenAIRuntimeProviderForPi({
        provider: "openai",
        harnessRuntime: "pi",
        authProfileProvider: "openai-codex",
        authProfileId: "openai-codex:work",
      }),
    ).toBe("openai-codex");
  });

  it("ignores session PI pins when validating OpenAI auth profiles", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toEqual(["openai-codex"]);
  });
});
