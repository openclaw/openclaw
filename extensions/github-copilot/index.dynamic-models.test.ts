import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  getIndexMocks,
  createAgentDir,
  createModelRegistry,
  writeProfiles,
} from "./index.test-support.js";

const mocks = getIndexMocks();

describe("github-copilot dynamic model resolution", () => {
  it("uses live catalog metadata for request-time model resolution", async () => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "github-copilot:first": {
        type: "token",
        provider: "github-copilot",
        token: "first",
      },
      "github-copilot:selected": {
        type: "token",
        provider: "github-copilot",
        token: "chosen",
      },
    });
    mocks.resolveCopilotRuntimeAuth
      .mockResolvedValueOnce({
        apiKey: "chosen",
        baseUrl: "https://api.githubcopilot.live",
      })
      .mockResolvedValueOnce({
        apiKey: "first",
        baseUrl: "https://api.githubcopilot.first",
      });
    const catalogResponse = (contextWindow: number, promptTokens: number, endpoint: string) =>
      Response.json({
        data: [
          {
            id: "endpoint-fixture",
            name: "Endpoint fixture",
            object: "model",
            vendor: "OpenAI",
            supported_endpoints: [endpoint],
            capabilities: {
              type: "chat",
              limits: {
                max_context_window_tokens: contextWindow,
                max_prompt_tokens: promptTokens,
                max_output_tokens: 128_000,
              },
              supports: {
                vision: true,
                reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
              },
            },
          },
        ],
      });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000, "/chat/completions"))
        .mockResolvedValueOnce(catalogResponse(400_000, 272_000, "/responses")),
    );
    const provider = registerProviderWithPluginConfig({});
    const modelRegistry = createModelRegistry();
    const selectedContext = {
      config: {},
      agentDir,
      provider: "github-copilot",
      modelId: "endpoint-fixture",
      modelRegistry,
      authProfileId: "github-copilot:selected",
    } as Parameters<typeof provider.prepareDynamicModel>[0];
    const firstContext = {
      ...selectedContext,
      authProfileId: "github-copilot:first",
    };

    await provider.prepareDynamicModel(selectedContext);
    await provider.prepareDynamicModel(firstContext);

    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(1, {
      githubToken: "chosen",
      env: process.env,
      githubDomain: "github.com",
    });
    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(2, {
      githubToken: "first",
      env: process.env,
      githubDomain: "github.com",
    });
    expect(provider.preferRuntimeResolvedModel(selectedContext)).toBe(true);
    expect(provider.resolveDynamicModel(selectedContext)).toMatchObject({
      id: "endpoint-fixture",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.live",
      api: "openai-completions",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      },
      thinkingLevelMap: { max: null },
      contextWindow: 1_050_000,
      contextTokens: 922_000,
      maxTokens: 128_000,
    });
    expect(provider.resolveDynamicModel(firstContext)).toMatchObject({
      id: "endpoint-fixture",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.first",
      api: "openai-responses",
      thinkingLevelMap: { max: "max" },
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("rematerializes direct-config metadata after a profile fallback", async () => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "github-copilot:first": {
        type: "token",
        provider: "github-copilot",
        token: "test-auth-token",
      },
    });
    mocks.resolveCopilotRuntimeAuth
      .mockResolvedValueOnce({
        apiKey: "test-auth-token",
        baseUrl: "https://api.githubcopilot.profile",
      })
      .mockResolvedValueOnce({
        apiKey: "test-token-placeholder",
        baseUrl: "https://api.githubcopilot.direct",
      });
    const catalogResponse = (contextWindow: number, promptTokens: number) =>
      Response.json({
        data: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            object: "model",
            vendor: "OpenAI",
            capabilities: {
              type: "chat",
              limits: {
                max_context_window_tokens: contextWindow,
                max_prompt_tokens: promptTokens,
                max_output_tokens: 128_000,
              },
            },
          },
        ],
      });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(catalogResponse(200_000, 150_000))
        .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000)),
    );
    const provider = registerProviderWithPluginConfig({});
    const modelRegistry = createModelRegistry();
    const config = {
      models: {
        providers: {
          "github-copilot": {
            apiKey: "test-token-placeholder",
            baseUrl: "https://api.githubcopilot.test",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const profileContext = {
      config,
      agentDir,
      provider: "github-copilot",
      modelId: "gpt-5.6-sol",
      modelRegistry,
      authProfileId: "github-copilot:first",
    } as Parameters<typeof provider.prepareDynamicModel>[0];
    const directContext = {
      ...profileContext,
      authProfileId: undefined,
      authProfileMode: "api_key" as const,
    };

    // The first profile's credential can fail later during runtime auth. The
    // prepared direct fallback must then replace its account-scoped limits.
    await provider.prepareDynamicModel(profileContext);
    await provider.prepareDynamicModel(directContext);

    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(1, {
      githubToken: "test-auth-token",
      env: process.env,
      githubDomain: "github.com",
    });
    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(2, {
      githubToken: "test-token-placeholder",
      env: process.env,
      githubDomain: "github.com",
    });
    expect(provider.resolveDynamicModel(profileContext)).toMatchObject({
      baseUrl: "https://api.githubcopilot.profile",
      contextWindow: 200_000,
      contextTokens: 150_000,
    });
    expect(provider.resolveDynamicModel(directContext)).toMatchObject({
      baseUrl: "https://api.githubcopilot.direct",
      contextWindow: 1_050_000,
      contextTokens: 922_000,
    });
  });
});

import { registerProviderWithPluginConfig } from "./provider.test-support.js";
