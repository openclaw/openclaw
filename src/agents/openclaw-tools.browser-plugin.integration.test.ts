// Verifies OpenClaw plugin tools are resolved with browser/runtime context.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMergePatchToPairedRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const hoisted = vi.hoisted(() => ({
  resolvePluginTools: vi.fn(),
}));

const BROKER_CAPABILITY_PROFILE = {
  serviceIdentity: { agentId: "main" },
  conversation: { sessionKey: "agent:main:discord:direct:alice", messageChannel: "discord" },
  sender: { id: "alice" },
};

vi.mock("../plugins/tools.js", () => ({
  copyPluginToolMeta: vi.fn(),
  getPluginToolMeta: vi.fn(),
  resolvePluginTools: (...args: unknown[]) => hoisted.resolvePluginTools(...args),
}));

function firstResolvePluginToolsParams(): Record<string, unknown> {
  // Captures the plugin runtime contract passed from OpenClaw tool resolution.
  const call = hoisted.resolvePluginTools.mock.calls[0];
  if (!call) {
    throw new Error("Expected plugin tool resolution");
  }
  return call[0] as Record<string, unknown>;
}

describe("createOpenClawTools browser plugin integration", () => {
  afterEach(() => {
    hoisted.resolvePluginTools.mockReset();
    clearSecretsRuntimeSnapshot();
    resetConfigRuntimeState();
  });

  it("keeps the browser tool returned by plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([
      {
        name: "browser",
        description: "browser fixture tool",
        parameters: {
          type: "object",
          properties: {},
        },
        async execute() {
          return {
            content: [{ type: "text", text: "ok" }],
          };
        },
      },
    ]);

    const config = {
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    const tools = resolveOpenClawPluginToolsForOptions({
      options: { config },
      resolvedConfig: config,
    });

    expect(tools.map((tool) => tool.name)).toContain("browser");
  });

  it("omits the browser tool when plugin resolution returns no browser tool", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);

    const config = {
      plugins: {
        allow: ["browser"],
        entries: {
          browser: {
            enabled: false,
          },
        },
      },
    } as OpenClawConfig;

    const tools = resolveOpenClawPluginToolsForOptions({
      options: { config },
      resolvedConfig: config,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("browser");
  });

  it("forwards fsPolicy into plugin tool context", async () => {
    let capturedContext: { fsPolicy?: { workspaceOnly: boolean } } | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      const resolvedParams = params as { context?: { fsPolicy?: { workspaceOnly: boolean } } };
      capturedContext = resolvedParams.context;
      return [
        {
          name: "browser",
          description: "browser fixture tool",
          parameters: {
            type: "object",
            properties: {},
          },
          async execute() {
            return {
              content: [{ type: "text", text: "ok" }],
              details: { workspaceOnly: capturedContext?.fsPolicy?.workspaceOnly ?? null },
            };
          },
        },
      ];
    });

    const tools = resolveOpenClawPluginToolsForOptions({
      options: {
        config: {
          plugins: {
            allow: ["browser"],
          },
        } as OpenClawConfig,
        fsPolicy: { workspaceOnly: true },
      },
      resolvedConfig: {
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
    });

    const browserTool = tools.find((tool) => tool.name === "browser");
    if (browserTool === undefined) {
      throw new Error("expected browser tool");
    }

    const result = await browserTool.execute("tool-call", {});
    const details = (result.details ?? {}) as { workspaceOnly?: boolean | null };
    expect(details.workspaceOnly).toBe(true);
  });

  it("forwards gateway subagent binding to plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const config = {
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: { config, allowGatewaySubagentBinding: true },
      resolvedConfig: config,
    });

    expect(hoisted.resolvePluginTools).toHaveBeenCalledTimes(1);
    expect(firstResolvePluginToolsParams().allowGatewaySubagentBinding).toBe(true);
  });

  it("forwards auth profile helpers to plugin resolution and context", async () => {
    let capturedParams:
      | {
          hasAuthForProvider?: (providerId: string) => boolean;
          context?: {
            hasAuthForProvider?: (providerId: string) => boolean;
            resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
          };
        }
      | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      capturedParams = params as typeof capturedParams;
      return [];
    });
    const config = {
      auth: {
        order: {
          xai: ["xai-profile"],
        },
      },
      plugins: {
        allow: ["xai"],
      },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: {
        config,
        authProfileStore: {
          version: 1,
          profiles: {
            "xai-excluded": {
              type: "api_key",
              provider: "xai",
              key: "xai-excluded-key", // pragma: allowlist secret
            },
            "xai-profile": {
              type: "api_key",
              provider: "xai",
              key: "xai-profile-key", // pragma: allowlist secret
            },
          },
        },
      },
      resolvedConfig: config,
    });

    expect(capturedParams?.hasAuthForProvider?.("xai")).toBe(true);
    expect(capturedParams?.context?.hasAuthForProvider?.("xai")).toBe(true);
    await expect(capturedParams?.context?.resolveApiKeyForProvider?.("xai")).resolves.toBe(
      "xai-profile-key",
    );
  });

  it("forwards plugin tool deny policy to plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const config = {
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: {
        config,
        pluginToolAllowlist: ["*"],
        pluginToolDenylist: ["browser"],
      },
      resolvedConfig: config,
    });

    expect(hoisted.resolvePluginTools).toHaveBeenCalledTimes(1);
    const params = firstResolvePluginToolsParams();
    expect(params.toolAllowlist).toEqual(["*"]);
    expect(params.toolDenylist).toEqual(["browser"]);
  });

  it("does not pass a stale active snapshot as plugin runtime config for a resolved run config", () => {
    // Resolved run config must win over any process-global runtime snapshot.
    const staleSourceConfig = {
      plugins: {
        allow: ["old-plugin"],
      },
    } as OpenClawConfig;
    const staleRuntimeConfig = {
      plugins: {
        allow: ["old-plugin"],
      },
    } as OpenClawConfig;
    const resolvedRunConfig = {
      plugins: {
        allow: ["browser"],
      },
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as OpenClawConfig;
    let capturedRuntimeConfig: OpenClawConfig | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      capturedRuntimeConfig = (params as { context?: { runtimeConfig?: OpenClawConfig } }).context
        ?.runtimeConfig;
      return [];
    });
    activateSecretsRuntimeSnapshot({
      sourceConfig: staleSourceConfig,
      config: staleRuntimeConfig,
      authStores: [],
      warnings: [],
      webTools: {
        search: {
          providerSource: "none",
          diagnostics: [],
        },
        fetch: {
          providerSource: "none",
          diagnostics: [],
        },
        diagnostics: [],
      },
    });

    resolveOpenClawPluginToolsForOptions({
      options: { config: resolvedRunConfig },
      resolvedConfig: resolvedRunConfig,
    });

    expect(capturedRuntimeConfig).toBe(resolvedRunConfig);
  });

  it("pairs scoped resolved config with its authored SecretRef for the credential broker", () => {
    const secretRef = { source: "env", provider: "default", id: "TAVILY_API_KEY" } as const;
    const sourceConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: secretRef } } } },
      },
      tools: { alsoAllow: ["tavily_search"] },
    } as OpenClawConfig;
    const runtimeConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: "resolved-value" } } } },
      },
      tools: { alsoAllow: ["tavily_search"] },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const scopedRuntimeConfig = applyMergePatchToPairedRuntimeConfig({
      runtimeConfig,
      patch: { tools: { alsoAllow: ["tavily_search", "tavily_extract"] } },
    });

    resolveOpenClawPluginToolsForOptions({
      options: {
        config: scopedRuntimeConfig,
        conversationCapabilityProfile: BROKER_CAPABILITY_PROFILE as never,
      },
      resolvedConfig: scopedRuntimeConfig,
    });

    const brokerContext = firstResolvePluginToolsParams().credentialBrokerContext as {
      sourceConfig: OpenClawConfig;
      runtimeConfig: OpenClawConfig;
    };
    expect(
      (
        brokerContext.sourceConfig.plugins?.entries?.tavily?.config as {
          webSearch?: { apiKey?: unknown };
        }
      ).webSearch?.apiKey,
    ).toEqual(secretRef);
    expect(
      (
        brokerContext.runtimeConfig.plugins?.entries?.tavily?.config as {
          webSearch?: { apiKey?: unknown };
        }
      ).webSearch?.apiKey,
    ).toBe("resolved-value");
    expect(brokerContext.sourceConfig.tools?.alsoAllow).toEqual([
      "tavily_search",
      "tavily_extract",
    ]);
  });

  it("retains a prepared config's SecretRef pairing across a runtime snapshot refresh", () => {
    const firstSecretRef = {
      source: "env",
      provider: "default",
      id: "FIRST_TAVILY_API_KEY",
    } as const;
    const firstSourceConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: firstSecretRef } } } },
      },
    } as OpenClawConfig;
    const firstRuntimeConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: "first-resolved-value" } } } },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(firstRuntimeConfig, firstSourceConfig);

    const nextSourceConfig = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "NEXT_TAVILY_API_KEY" },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const nextRuntimeConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: "next-resolved-value" } } } },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(nextRuntimeConfig, nextSourceConfig);

    resolveOpenClawPluginToolsForOptions({
      options: {
        config: firstRuntimeConfig,
        conversationCapabilityProfile: BROKER_CAPABILITY_PROFILE as never,
      },
      resolvedConfig: firstRuntimeConfig,
    });

    const brokerContext = firstResolvePluginToolsParams().credentialBrokerContext as {
      sourceConfig: OpenClawConfig;
      runtimeConfig: OpenClawConfig;
    };
    expect(
      (
        brokerContext.sourceConfig.plugins?.entries?.tavily?.config as {
          webSearch?: { apiKey?: unknown };
        }
      ).webSearch?.apiKey,
    ).toEqual(firstSecretRef);
    expect(brokerContext.runtimeConfig).toBe(firstRuntimeConfig);
  });

  it("does not associate an unrelated literal config with the active SecretRef snapshot", () => {
    const secretRef = { source: "env", provider: "default", id: "TAVILY_API_KEY" } as const;
    const sourceConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: secretRef } } } },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: "active-resolved-value" } } } },
      },
    } as OpenClawConfig;
    const explicitConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: "explicit-literal-value" } } } },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    resolveOpenClawPluginToolsForOptions({
      options: {
        config: explicitConfig,
        conversationCapabilityProfile: BROKER_CAPABILITY_PROFILE as never,
      },
      resolvedConfig: explicitConfig,
    });

    const brokerContext = firstResolvePluginToolsParams().credentialBrokerContext as {
      sourceConfig: OpenClawConfig;
      runtimeConfig?: OpenClawConfig;
    };
    expect(brokerContext.runtimeConfig).toBeUndefined();
    expect(
      (
        brokerContext.sourceConfig.plugins?.entries?.tavily?.config as {
          webSearch?: { apiKey?: unknown };
        }
      ).webSearch?.apiKey,
    ).toBe("explicit-literal-value");
  });

  it("omits brokered tools when the prepared profile lacks sender scope", () => {
    const secretRef = { source: "env", provider: "default", id: "TAVILY_API_KEY" } as const;
    const sourceConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: secretRef } } } },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: "resolved-value" } } } },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    resolveOpenClawPluginToolsForOptions({
      options: {
        config: runtimeConfig,
        conversationCapabilityProfile: {
          ...BROKER_CAPABILITY_PROFILE,
          sender: {},
        } as never,
      },
      resolvedConfig: runtimeConfig,
    });

    const params = firstResolvePluginToolsParams();
    expect(params.credentialBrokerContext).toBeUndefined();
    expect(params.omitCredentialBrokerToolsWithoutContext).toBe(true);
  });

  it("prepares a fail-closed capability profile for direct tool assembly", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const secretRef = { source: "env", provider: "default", id: "TAVILY_API_KEY" } as const;
    const sourceConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: secretRef } } } },
      },
      tools: { alsoAllow: ["tavily_search"] },
    } as OpenClawConfig;
    const runtimeConfig = {
      plugins: {
        entries: { tavily: { config: { webSearch: { apiKey: "resolved-value" } } } },
      },
      tools: { alsoAllow: ["tavily_search"] },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    createOpenClawTools({
      config: runtimeConfig,
      agentSessionKey: "agent:main:discord:direct:alice",
      agentChannel: "discord",
      requesterAgentIdOverride: "main",
      requesterSenderId: "alice",
      pluginToolAllowlist: ["tavily_search"],
      wrapBeforeToolCallHook: false,
    });

    const brokerContext = firstResolvePluginToolsParams().credentialBrokerContext as {
      profile: {
        conversation: { sessionKey?: string; messageChannel?: string };
        sender: { id?: string | null };
      };
      sourceConfig: OpenClawConfig;
    };
    expect(brokerContext.profile.conversation).toMatchObject({
      sessionKey: "agent:main:discord:direct:alice",
      messageChannel: "discord",
    });
    expect(brokerContext.profile.sender.id).toBe("alice");
    expect(
      (
        brokerContext.sourceConfig.plugins?.entries?.tavily?.config as {
          webSearch?: { apiKey?: unknown };
        }
      ).webSearch?.apiKey,
    ).toEqual(secretRef);
  });

  it("does not let a source-less pinned config snapshot override explicit plugin tool config", () => {
    const pinnedRuntimeConfig = {
      plugins: {
        allow: ["old-plugin"],
      },
    } as OpenClawConfig;
    const explicitConfig = {
      plugins: {
        allow: ["browser"],
      },
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as OpenClawConfig;
    let capturedRuntimeConfig: OpenClawConfig | undefined;
    let getRuntimeConfig: (() => OpenClawConfig | undefined) | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      const context = (
        params as {
          context?: {
            runtimeConfig?: OpenClawConfig;
            getRuntimeConfig?: () => OpenClawConfig | undefined;
          };
        }
      ).context;
      capturedRuntimeConfig = context?.runtimeConfig;
      getRuntimeConfig = context?.getRuntimeConfig;
      return [];
    });
    setRuntimeConfigSnapshot(pinnedRuntimeConfig);

    resolveOpenClawPluginToolsForOptions({
      options: { config: explicitConfig },
      resolvedConfig: explicitConfig,
    });

    expect(capturedRuntimeConfig).toBe(explicitConfig);
    expect(getRuntimeConfig?.()).toBe(explicitConfig);
  });

  it("exposes a live runtime config getter to plugin tool factories", () => {
    const sourceConfig = {
      plugins: {
        allow: ["memory-core"],
      },
    } as OpenClawConfig;
    const firstRuntimeConfig = {
      plugins: {
        allow: ["memory-core"],
        entries: { "memory-core": { enabled: true } },
      },
    } as OpenClawConfig;
    const nextRuntimeConfig = {
      plugins: {
        allow: ["memory-core"],
        entries: { "memory-core": { enabled: false } },
      },
    } as OpenClawConfig;
    let getRuntimeConfig: (() => OpenClawConfig | undefined) | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      getRuntimeConfig = (
        params as { context?: { getRuntimeConfig?: () => OpenClawConfig | undefined } }
      ).context?.getRuntimeConfig;
      return [];
    });
    setRuntimeConfigSnapshot(firstRuntimeConfig, sourceConfig);

    resolveOpenClawPluginToolsForOptions({
      options: { config: sourceConfig },
      resolvedConfig: sourceConfig,
    });

    expect(getRuntimeConfig?.()).toStrictEqual(firstRuntimeConfig);

    setRuntimeConfigSnapshot(nextRuntimeConfig, sourceConfig);

    expect(getRuntimeConfig?.()).toStrictEqual(nextRuntimeConfig);
    expect(getRuntimeConfig?.()?.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
  });
});
