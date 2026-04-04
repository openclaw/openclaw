import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    configText: "{}\n",
  };

  const catalog = {
    source: "live" as const,
    models: [
      {
        id: "dench-claude-sonnet",
        stableId: "claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        provider: "anthropic",
        transportProvider: "dench-cloud",
        api: "openai-completions" as const,
        input: ["text"] as Array<"text" | "image">,
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 8192,
        supportsStreaming: true,
        supportsImages: false,
        supportsResponses: true,
        supportsReasoning: true,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    ],
  };

  return {
    state,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => state.configText as never),
    writeFileSync: vi.fn((pathLike: unknown, content: unknown) => {
      if (String(pathLike).endsWith("openclaw.json")) {
        state.configText = String(content);
      }
    }),
    mkdirSync: vi.fn(),
    validateDenchCloudApiKey: vi.fn(async () => undefined),
    fetchDenchCloudCatalog: vi.fn(async () => catalog),
    buildDenchCloudConfigPatch: vi.fn((params: { gatewayUrl: string; apiKey: string }) => ({
      models: {
        providers: {
          "dench-cloud": {
            apiKey: params.apiKey,
            baseUrl: `${params.gatewayUrl}/v1`,
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "dench-cloud/claude-sonnet-4.6": {
              name: "Claude Sonnet 4.6",
            },
          },
        },
      },
      messages: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              baseUrl: params.gatewayUrl,
              apiKey: params.apiKey,
            },
          },
        },
      },
      mcp: {
        servers: {
          composio: {
            url: `${params.gatewayUrl}/v1/composio/mcp`,
            transport: "streamable-http",
            headers: {
              Authorization: `Bearer ${params.apiKey}`,
            },
          },
        },
      },
    })),
    readConfiguredDenchCloudSettings: vi.fn(() => ({
      gatewayUrl: null,
      selectedModel: null,
    })),
    refreshIntegrationsRuntime: vi.fn(async () => ({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    })),
    rebuildComposioToolIndexIfReady: vi.fn(async () => ({
      ok: false as const,
      reason: "Dench Cloud must be the primary provider.",
    })),
  };
});

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
  mkdirSync: mocks.mkdirSync,
}));

vi.mock("../../../src/cli/dench-cloud", () => ({
  DEFAULT_DENCH_CLOUD_GATEWAY_URL: "https://gateway.merseoriginals.com",
  normalizeDenchGatewayUrl: (value: string) => value,
  buildDenchGatewayApiBaseUrl: (gatewayUrl: string) => `${gatewayUrl}/v1`,
  fetchDenchCloudCatalog: mocks.fetchDenchCloudCatalog,
  validateDenchCloudApiKey: mocks.validateDenchCloudApiKey,
  buildDenchCloudConfigPatch: mocks.buildDenchCloudConfigPatch,
  readConfiguredDenchCloudSettings: mocks.readConfiguredDenchCloudSettings,
  RECOMMENDED_DENCH_CLOUD_MODEL_ID: "claude-sonnet-4.6",
}));

vi.mock("./integrations", () => ({
  refreshIntegrationsRuntime: mocks.refreshIntegrationsRuntime,
}));

vi.mock("./composio-tool-index", () => ({
  rebuildComposioToolIndexIfReady: mocks.rebuildComposioToolIndexIfReady,
}));

import { saveApiKey, saveVoiceId, selectModel } from "./dench-cloud-settings";

describe("dench cloud settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.configText = "{}\n";
    mocks.validateDenchCloudApiKey.mockResolvedValue(undefined);
    mocks.fetchDenchCloudCatalog.mockResolvedValue({
      source: "live",
      models: [
        {
          id: "dench-claude-sonnet",
          stableId: "claude-sonnet-4.6",
          displayName: "Claude Sonnet 4.6",
          provider: "anthropic",
          transportProvider: "dench-cloud",
          api: "openai-completions",
          input: ["text"],
          reasoning: true,
          contextWindow: 200000,
          maxTokens: 8192,
          supportsStreaming: true,
          supportsImages: false,
          supportsResponses: true,
          supportsReasoning: true,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      ],
    });
    mocks.refreshIntegrationsRuntime.mockResolvedValue({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    });
    mocks.rebuildComposioToolIndexIfReady.mockResolvedValue({
      ok: false,
      reason: "Dench Cloud must be the primary provider.",
    });
  });

  it("rebuilds the Composio index when saving the Dench Cloud API key", async () => {
    const result = await saveApiKey("dc-key");

    expect(mocks.rebuildComposioToolIndexIfReady).toHaveBeenCalledTimes(1);
    expect(mocks.refreshIntegrationsRuntime).toHaveBeenCalledTimes(1);
    expect(result.toolIndexRebuild).toEqual({
      ok: false,
      reason: "Dench Cloud must be the primary provider.",
    });

    const written = JSON.parse(mocks.state.configText);
    expect(written.models.providers["dench-cloud"].apiKey).toBe("dc-key");
    expect(written.mcp.servers.composio.url).toBe(
      "https://gateway.merseoriginals.com/v1/composio/mcp",
    );
  });

  it("rebuilds the Composio index when switching the primary model to Dench Cloud", async () => {
    mocks.state.configText = JSON.stringify({
      models: {
        providers: {
          "dench-cloud": {
            apiKey: "dc-key",
          },
        },
      },
    });
    mocks.rebuildComposioToolIndexIfReady.mockResolvedValue({
      ok: true,
      workspaceDir: "/tmp/workspace",
      generated_at: "2026-04-02T00:00:00.000Z",
      connected_apps: 2,
    });

    const result = await selectModel("claude-sonnet-4.6");

    expect(mocks.rebuildComposioToolIndexIfReady).toHaveBeenCalledTimes(1);
    expect(mocks.refreshIntegrationsRuntime).toHaveBeenCalledTimes(1);
    expect(result.toolIndexRebuild).toMatchObject({
      ok: true,
      connected_apps: 2,
    });

    const written = JSON.parse(mocks.state.configText);
    expect(written.agents.defaults.model.primary).toBe("dench-cloud/claude-sonnet-4.6");
    expect(written.mcp.servers.composio.headers.Authorization).toBe("Bearer dc-key");
  });

  it("preserves a stored voiceId without re-enabling ElevenLabs during model changes", async () => {
    mocks.state.configText = JSON.stringify({
      models: {
        providers: {
          "dench-cloud": {
            apiKey: "dc-key",
          },
        },
      },
      messages: {
        tts: {
          providers: {
            elevenlabs: {
              voiceId: "voice_123",
            },
          },
        },
      },
    });

    await selectModel("claude-sonnet-4.6");

    const written = JSON.parse(mocks.state.configText);
    expect(written.messages.tts.provider).toBeUndefined();
    expect(written.messages.tts.providers.elevenlabs).toEqual({
      voiceId: "voice_123",
    });
  });

  it("stores the selected ElevenLabs voice without restarting the gateway", async () => {
    const result = await saveVoiceId("voice_456");

    expect(result.changed).toBe(true);
    expect(result.refresh).toEqual({
      attempted: false,
      restarted: false,
      error: null,
      profile: "default",
    });

    const written = JSON.parse(mocks.state.configText);
    expect(written.messages.tts.providers.elevenlabs.voiceId).toBe("voice_456");
  });
});
