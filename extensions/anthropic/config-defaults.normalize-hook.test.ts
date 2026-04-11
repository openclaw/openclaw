import { describe, expect, it } from "vitest";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-shared.js";
import {
  normalizeAnthropicProviderConfig,
  normalizeAnthropicProviderConfigForPluginHook,
} from "./config-defaults.js";

describe("normalizeAnthropicProviderConfigForPluginHook", () => {
  it("does not apply Anthropic relay api defaults to openai-codex", () => {
    const providerConfig = {
      baseUrl: "https://chatgpt.com/backend-api",
      models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
    };
    expect(
      normalizeAnthropicProviderConfigForPluginHook({
        provider: "openai-codex",
        providerConfig,
      }),
    ).toBeUndefined();
    expect(normalizeAnthropicProviderConfig(providerConfig)).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("applies relay api default for anthropic when models exist and api is missing", () => {
    expect(
      normalizeAnthropicProviderConfigForPluginHook({
        provider: "anthropic",
        providerConfig: {
          baseUrl: "https://api.anthropic.com",
          models: [{ id: "claude-sonnet-4-6" }],
        },
      }),
    ).toMatchObject({ api: "anthropic-messages" });
  });

  it("applies relay api default for Claude CLI provider key", () => {
    expect(
      normalizeAnthropicProviderConfigForPluginHook({
        provider: CLAUDE_CLI_BACKEND_ID,
        providerConfig: {
          baseUrl: "https://api.anthropic.com",
          models: [{ id: "claude-sonnet-4-6" }],
        },
      }),
    ).toMatchObject({ api: "anthropic-messages" });
  });
});
