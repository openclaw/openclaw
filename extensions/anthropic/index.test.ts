import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";

const { readClaudeCliCredentialsCachedMock } = vi.hoisted(() => ({
  readClaudeCliCredentialsCachedMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    readClaudeCliCredentialsCached: readClaudeCliCredentialsCachedMock,
  };
});

import anthropicPlugin from "./index.js";

describe("anthropic provider replay hooks", () => {
  it("owns native reasoning output mode for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toBe("native");
  });

  it("owns replay policy for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
    });
  });

  it("defaults provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "anthropic",
        providerConfig: {
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      } as never),
    ).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("applies Anthropic pruning defaults through plugin hooks", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.contextPruning).toMatchObject({
      mode: "cache-ttl",
      ttl: "1h",
    });
    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "30m",
    });
    expect(
      next?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("resolves claude-cli synthetic auth without allowing keychain prompts", async () => {
    readClaudeCliCredentialsCachedMock.mockReset();
    readClaudeCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "access-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
    expect(readClaudeCliCredentialsCachedMock).toHaveBeenCalledWith({
      allowKeychainPrompt: false,
    });
  });
});
