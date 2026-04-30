import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderPlugin } from "../plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
}));

vi.mock("../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  }),
  normalizePluginDiscoveryResult: ({
    provider,
    result,
  }: {
    provider: ProviderPlugin;
    result?: { provider?: unknown; providers?: Record<string, unknown> } | null;
  }) => result?.providers ?? (result?.provider ? { [provider.id]: result.provider } : {}),
}));

import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

function metadataOwners(
  overrides: Partial<PluginMetadataSnapshotOwnerMaps>,
): PluginMetadataSnapshotOwnerMaps {
  return {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    ...overrides,
  };
}

function createProvider(id: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    catalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

describe("resolveImplicitProviders startup discovery scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("openai")]);
    mocks.runProviderCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
  });

  it("passes startup provider scopes as plugin owner filters", async () => {
    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          providers: new Map([["openai", ["openai"]]]),
        }),
      },
      providerDiscoveryProviderIds: ["openai"],
      providerDiscoveryTimeoutMs: 1234,
    });

    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openai"],
      }),
    );
    expect(mocks.runProviderCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1234,
      }),
    );
  });

  it("can keep startup discovery on provider discovery entries only", async () => {
    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      providerDiscoveryEntriesOnly: true,
    });

    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveryEntriesOnly: true,
      }),
    );
  });

  it("preserves GitHub Copilot IDE headers when explicit headers are configured", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValueOnce([
      createProvider("github-copilot"),
    ]);
    mocks.runProviderCatalog.mockResolvedValueOnce({
      providers: {
        "github-copilot": {
          baseUrl: "https://api.githubcopilot.test",
          headers: {
            "User-Agent": "GitHubCopilotChat/0.35.0",
            "Editor-Version": "vscode/1.107.0",
            "Editor-Plugin-Version": "copilot-chat/0.35.0",
            "Copilot-Integration-Id": "vscode-chat",
          },
          models: [{ id: "gpt-new", name: "gpt-new" }],
        },
      },
    });

    await expect(
      resolveImplicitProviders({
        agentDir: "/tmp/openclaw-agent",
        config: {
          models: {
            providers: {
              "github-copilot": {
                headers: {
                  "X-Proxy-Auth": "proxy-token",
                },
              },
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        explicitProviders: {},
      }),
    ).resolves.toEqual({
      "github-copilot": {
        baseUrl: "https://api.githubcopilot.test",
        headers: {
          "User-Agent": "GitHubCopilotChat/0.35.0",
          "Editor-Version": "vscode/1.107.0",
          "Editor-Plugin-Version": "copilot-chat/0.35.0",
          "Copilot-Integration-Id": "vscode-chat",
          "X-Proxy-Auth": "proxy-token",
        },
        models: [{ id: "gpt-new", name: "gpt-new" }],
      },
    });
  });
});
