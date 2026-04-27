import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
  githubCopilotLoginCommand: vi.fn(),
  fetchCopilotUsage: vi.fn(),
}));

import plugin, { mapCopilotWireModel } from "./index.js";

function _registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "github-copilot",
      name: "GitHub Copilot",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("github-copilot plugin", () => {
  it("registers embedding provider", () => {
    const registerMemoryEmbeddingProviderMock = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider: vi.fn(),
        registerMemoryEmbeddingProvider: registerMemoryEmbeddingProviderMock,
      }),
    );

    expect(registerMemoryEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    const adapter = registerMemoryEmbeddingProviderMock.mock.calls[0]?.[0];
    expect(adapter.id).toBe("github-copilot");
  });

  it("skips catalog discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(result).toBeNull();
    expect(resolveCopilotApiTokenMock).not.toHaveBeenCalled();
  });

  it("uses live plugin config to re-enable discovery after startup disable", async () => {
    resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot_api_token",
      baseUrl: "https://api.githubcopilot.live",
    });
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const result = await provider.catalog.run({
        config: {
          plugins: {
            entries: {
              "github-copilot": {
                config: {
                  discovery: { enabled: true },
                },
              },
            },
          },
        },
        agentDir: "/tmp/agent",
        env: { GH_TOKEN: "gh_test_token" },
        resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
      } as never);

      expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith({
        githubToken: "gh_test_token",
        env: { GH_TOKEN: "gh_test_token" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.githubcopilot.live/models",
        expect.any(Object),
      );
      expect(result).toEqual({
        provider: {
          baseUrl: "https://api.githubcopilot.live",
          models: [],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps Copilot /models capabilities into provider catalog metadata", () => {
    const result = mapCopilotWireModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      capabilities: {
        limits: {
          max_context_window_tokens: 400_000,
          max_output_tokens: 128_000,
          vision: {
            max_prompt_images: 1,
          },
        },
        supports: {
          reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
          vision: true,
        },
      },
      supported_endpoints: ["/responses", "ws:/responses"],
    });

    expect(result).toMatchObject({
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      metadataSource: "models-add",
    });
  });

  it("maps Anthropic-compatible endpoints broadly", () => {
    for (const endpoint of [
      "/v1/messages",
      "/messages",
      "/chat/v1/messages",
      "/anthropic/messages",
    ]) {
      expect(
        mapCopilotWireModel({
          id: "claude-opus-4.7",
          capabilities: { limits: {}, supports: {} },
          supported_endpoints: [endpoint],
        }),
      ).toMatchObject({ api: "anthropic-messages" });
    }
  });

  it("fetches Copilot /models during catalog discovery", async () => {
    resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot_api_token",
      baseUrl: "https://api.githubcopilot.live",
    });
    const provider = registerProviderWithPluginConfig({});
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-5.5",
                capabilities: {
                  limits: {
                    max_context_window_tokens: 400_000,
                    max_output_tokens: 128_000,
                  },
                  supports: {
                    reasoning_effort: ["none", "high"],
                  },
                },
                supported_endpoints: ["/responses"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const result = await provider.catalog.run({
        config: {},
        agentDir: "/tmp/agent",
        env: { GH_TOKEN: "gh_test_token" },
        resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
      } as never);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.githubcopilot.live/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer copilot_api_token",
            "Copilot-Integration-Id": "vscode-chat",
          }),
        }),
      );
      expect(result.provider.models).toEqual([
        expect.objectContaining({
          id: "gpt-5.5",
          contextWindow: 400_000,
          maxTokens: 128_000,
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
