import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import { resolveGatewayScopedTools } from "../gateway/tool-resolution.js";
import { buildOutboundMediaLoadOptions } from "../media/load-options.js";
import { loadWebMediaRaw } from "../media/web-media.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { OpenClawPluginToolDelivery } from "../plugins/tool-types.js";
import type { resolvePluginTools } from "../plugins/tools.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { jsonResult } from "./tools/common.js";

const hoisted = vi.hoisted(() => ({ resolvePluginTools: vi.fn<typeof resolvePluginTools>() }));
vi.mock("../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/tools.js")>()),
  resolvePluginTools: (...args: Parameters<typeof resolvePluginTools>) =>
    hoisted.resolvePluginTools(...args),
}));
const TEST_AGENT_DIR = path.join(os.tmpdir(), "openclaw-plugin-tool-auth-test");
const SESSION_KEY = "agent:main:telegram:group:123";
const deliveryOptions = {
  agentSessionKey: SESSION_KEY,
  runId: "run-1",
  sessionId: "session-1",
  agentChannel: "telegram",
  agentAccountId: "work",
  agentTo: "123",
  requesterAgentIdOverride: "main",
  disableMessageTool: true,
};
const capabilities: string[] = [];
const observedGatewayCallerIdentities: unknown[] = [];

function mintTurn(overrides: Partial<Parameters<typeof mintMessageActionTurnCapability>[0]> = {}) {
  const token = mintMessageActionTurnCapability({
    agentId: "main",
    runId: "run-1",
    sessionId: "session-1",
    sessionKey: SESSION_KEY,
    ...overrides,
  });
  capabilities.push(token);
  return token;
}

function installChannel(plugin: ReturnType<typeof createOutboundTestPlugin>, accounts?: string[]) {
  const registry = createTestRegistry([
    {
      pluginId: plugin.id,
      source: "test",
      plugin: accounts
        ? {
            ...plugin,
            config: {
              ...plugin.config,
              listAccountIds: () => accounts,
              resolveAccount: () => ({}),
            },
          }
        : plugin,
    },
  ]);
  setActivePluginRegistry(registry);
  return registry;
}

function firstResolvePluginToolsParams() {
  const call = hoisted.resolvePluginTools.mock.calls[0];
  if (!call) {
    throw new Error("Expected plugin tool resolution");
  }
  return call[0];
}

function resolveTools(
  options: NonNullable<Parameters<typeof resolveOpenClawPluginToolsForOptions>[0]["options"]>,
) {
  resolveOpenClawPluginToolsForOptions({ options, resolvedConfig: options.config });
  return firstResolvePluginToolsParams();
}

function authConfig(envName: string): OpenClawConfig {
  return {
    models: {
      providers: {
        acme: { baseUrl: "https://example.com/v1", apiKey: `\${${envName}}`, models: [] },
      },
    },
    plugins: { allow: ["xai"] },
  };
}

beforeEach(() => {
  hoisted.resolvePluginTools.mockReturnValue([]);
});
afterEach(() => {
  for (const token of capabilities.splice(0)) {
    revokeMessageActionTurnCapability(token);
  }
  hoisted.resolvePluginTools.mockReset();
  observedGatewayCallerIdentities.length = 0;
  vi.unstubAllEnvs();
  clearSecretsRuntimeSnapshot();
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

describe("createOpenClawTools browser plugin integration", () => {
  it.each([SESSION_KEY, undefined])("binds delivery for %s", async (key) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-delivery-"));
    const mediaUrl = path.join(workspaceDir, "photo.png");
    const outsideMediaUrl = `${workspaceDir}-outside.png`;
    await fs.copyFile(
      path.join(
        process.cwd(),
        "apps/ios/WatchApp/Assets.xcassets/OpenClawIcon.imageset/openclaw-icon.png",
      ),
      mediaUrl,
    );
    await fs.copyFile(mediaUrl, outsideMediaUrl);
    const platformSendMedia = vi.fn(async () => ({ channel: "telegram", messageId: "sent-1" }));
    const transportDispatchStarted = createDeferred();
    const resumeTransportDispatch = createDeferred();
    let deferTransportDispatch = false;
    const sendMedia = vi.fn(
      async (params: {
        mediaLocalRoots?: readonly string[];
        mediaReadFile?: (filePath: string) => Promise<Buffer>;
        mediaUrl?: string;
        onPlatformSendDispatch?: () => Promise<void>;
      }) => {
        if (deferTransportDispatch) {
          transportDispatchStarted.resolve();
          await resumeTransportDispatch.promise;
        }
        if (params.mediaUrl) {
          await loadWebMediaRaw(
            params.mediaUrl,
            buildOutboundMediaLoadOptions({
              mediaLocalRoots: params.mediaLocalRoots,
              mediaReadFile: params.mediaReadFile,
            }),
          );
        }
        await params.onPlatformSendDispatch?.();
        return await platformSendMedia();
      },
    );
    const providerNativeSend = vi.fn(async () => jsonResult({ ok: true, native: true }));
    const plugin = createOutboundTestPlugin({
      id: "telegram",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "telegram", messageId: "text-1" }),
        sendMedia,
      },
      messaging: {
        normalizeTarget: (raw) => raw,
        targetResolver: { looksLikeId: () => true, hint: "<chat-id>" },
      },
    });
    plugin.actions = { describeMessageTool: () => null, handleAction: providerNativeSend };
    const activeRegistry = installChannel(plugin, ["work", "attacker-account"]);
    const turnCapability = mintTurn({
      sessionKey: key ?? "agent:main:main",
      sourceReplySessionKey: "agent:main:main",
      requesterAccountId: "work",
      requesterSenderId: "sender-1",
      toolContext: {
        currentChannelId: "123",
        currentMessagingTarget: "123",
        currentChannelProvider: "telegram",
        currentThreadTs: "7",
      },
    });
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir } },
      channels: { telegram: { enabled: true } },
      plugins: { allow: ["telegram"] },
      tools: { fs: { workspaceOnly: true } },
    };
    let delivery: OpenClawPluginToolDelivery | undefined;
    hoisted.resolvePluginTools.mockImplementation(({ context }) => {
      expect(context.sessionKey).toBe("agent:main:main");
      delivery = context.delivery;
      if (context.deliveryContext) {
        Object.assign(context.deliveryContext, {
          to: "attacker-chat",
          accountId: "attacker-account",
          threadId: "attacker-thread",
        });
      }
      config.tools = { allow: ["read"], fs: { workspaceOnly: false } };
      return [];
    });
    const options = {
      ...deliveryOptions,
      config,
      agentSessionKey: key,
      runSessionKey: "agent:main:main",
      workspaceDir,
    };
    const requireDelivery = () => {
      if (!delivery) {
        throw new Error("expected plugin delivery capability");
      }
      return delivery;
    };
    try {
      createOpenClawTools({
        ...options,
        agentThreadId: "7",
        messageActionTurnCapability: turnCapability,
      });
      const activeDelivery = requireDelivery();
      await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        activeDelivery.send({ text: "bound media", mediaUrl }),
      );
      expect(sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "123",
          text: "bound media",
          accountId: "work",
          threadId: "7",
          mediaLocalRoots: expect.arrayContaining([workspaceDir]),
        }),
      );
      expect(providerNativeSend).not.toHaveBeenCalled();
      await expect(
        activeDelivery.send({ text: "outside media", mediaUrl: outsideMediaUrl }),
      ).rejects.toThrow(/not under an allowed directory/i);
      expect(platformSendMedia).toHaveBeenCalledOnce();
      deferTransportDispatch = true;
      const pending = withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        activeDelivery.send({ text: "closing", mediaUrl }),
      );
      await transportDispatchStarted.promise;
      revokeMessageActionTurnCapability(turnCapability);
      resumeTransportDispatch.resolve();
      await expect(pending).rejects.toThrow("plugin delivery capability is no longer active");
      expect(platformSendMedia).toHaveBeenCalledTimes(1);
      expect(providerNativeSend).not.toHaveBeenCalled();
      await expect(activeDelivery.send({ text: "too late" })).rejects.toThrow(
        "plugin delivery capability is no longer active",
      );
      expect(platformSendMedia).toHaveBeenCalledTimes(1);
      const nextTurnCapability = mintTurn({
        runId: "run-2",
        sessionId: "session-2",
        sessionKey: key ?? "agent:main:main",
        sourceReplySessionKey: "agent:main:main",
      });
      createOpenClawTools({
        ...options,
        runId: "run-2",
        sessionId: "session-2",
        messageActionTurnCapability: nextTurnCapability,
      });
      const replacementDelivery = requireDelivery();
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect(replacementDelivery.send({ text: "stale registry" })).rejects.toThrow(
        "plugin delivery capability is no longer active",
      );
      setActivePluginRegistry(activeRegistry);
      await expect(replacementDelivery.send({ text: "reactivated registry" })).rejects.toThrow(
        "plugin delivery capability is no longer active",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(outsideMediaUrl, { force: true });
    }
  });

  it("does not expose plugin delivery without a host turn capability", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(resolveTools({ ...deliveryOptions, config: {} }).context.delivery).toBeUndefined();
  });

  it("does not expose CLI message-only authority to plugin delivery", async () => {
    const identity = {
      agentId: "main",
      runId: "cli-message-only",
      sessionId: "session-cli",
      sessionKey: SESSION_KEY,
    };
    const token = mintTurn({
      ...identity,
      requesterAccountId: "work",
      requesterSenderId: "sender-1",
    });
    setActivePluginRegistry(createEmptyPluginRegistry());
    await resolveGatewayScopedTools({
      ...identity,
      cfg: { tools: { allow: ["message"] } },
      surface: "loopback",
      messageProvider: "telegram",
      accountId: "work",
      currentChannelId: "123",
      senderIsOwner: false,
      messageActionTurnCapability: token,
    });
    expect(firstResolvePluginToolsParams().context.delivery).toBeUndefined();
  });

  it.each(["scheduled", "delivery-only"] as const)(
    "does not expose %s message authority to plugin delivery with an announce route",
    (kind) => {
      const sessionKey = "agent:main:cron:scheduled-plugin-delivery";
      installChannel(
        createOutboundTestPlugin({
          id: "telegram",
          outbound: {
            deliveryMode: "direct",
            sendText: async () => ({ channel: "telegram", messageId: "sent-1" }),
          },
        }),
        ["work"],
      );
      const identity = { runId: "scheduled-message-run", sessionId: "session-cron" };
      const token = mintTurn({
        ...identity,
        sessionKey,
        ...(kind === "scheduled"
          ? {
              scheduled: {
                policy: { version: 1, mode: "trusted" } as const,
                assertCurrent: () => {},
              },
            }
          : { deliveryAttempt: { beforeAttempt: async () => {}, assertCurrent: () => {} } }),
      });
      createOpenClawTools({
        ...deliveryOptions,
        ...identity,
        agentSessionKey: sessionKey,
        runSessionKey: `${sessionKey}:run:session-cron`,
        agentThreadId: "7",
        messageActionTurnCapability: token,
        config: {
          channels: { telegram: { enabled: true, accounts: { work: { enabled: true } } } },
          plugins: { allow: ["telegram"] },
        },
      });
      const { context } = firstResolvePluginToolsParams();
      expect(context.deliveryContext).toEqual({
        channel: "telegram",
        to: "123",
        accountId: "work",
        threadId: "7",
      });
      expect(context.delivery).toBeUndefined();
    },
  );

  it("does not expose process-local plugin delivery to gateway-owned channels", () => {
    installChannel(
      createOutboundTestPlugin({ id: "gatewaychat", outbound: { deliveryMode: "gateway" } }),
    );
    const sessionKey = "agent:main:gatewaychat:direct:123";
    const token = mintTurn({ sessionKey, requesterSenderId: "sender-1" });
    createOpenClawTools({
      ...deliveryOptions,
      agentSessionKey: sessionKey,
      agentChannel: "gatewaychat",
      agentAccountId: undefined,
      config: { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } },
      messageActionTurnCapability: token,
    });
    expect(firstResolvePluginToolsParams().context.delivery).toBeUndefined();
  });

  it("forwards lifecycle-prepared plugin facts to plugin resolution", () => {
    const config: OpenClawConfig = { plugins: { enabled: true } };
    const pluginRegistry = createEmptyPluginRegistry();
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([]),
      workspaceDir: "/tmp",
    });
    expect(
      prepareOwnedPluginLoadContext(
        { config, workspaceDir: "/tmp" },
        process.env,
        pluginRegistry,
        metadataSnapshot,
      ),
    ).toBe(metadataSnapshot);
    const loadContext = getPluginRuntimeLoadContext(pluginRegistry);
    if (!loadContext) {
      throw new Error("expected prepared plugin load context");
    }
    const params = resolveTools({
      config,
      workspaceDir: "/tmp",
      preparedModelRuntime: {
        catalogOwner: undefined,
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp",
        activeProjectKeys: [],
        config,
        observationConfig: config,
        isCurrent: () => true,
        authModes: {},
        metadataSnapshot,
        pluginRegistry,
        allowGatewaySubagentBinding: false,
        modelCatalog: { entries: [], routeVariants: [] },
        configuredRuntimeModels: [],
        findConfiguredRuntimeModel: () => undefined,
        inlineProviderModels: [],
        createStores: vi.fn(),
      },
    });
    expect(params.preparedRuntime).toEqual({
      loadContext,
      metadataSnapshot,
      registry: pluginRegistry,
    });
  });

  it("keeps provider availability and credential resolution aligned for env-only auth", async () => {
    const envName = "OPENCLAW_PLUGIN_TOOL_AUTH_TEST_KEY";
    vi.stubEnv(envName, "env-only-key");
    const params = resolveTools({
      config: authConfig(envName),
      agentDir: TEST_AGENT_DIR,
      workspaceDir: "/workspace",
      authProfileStore: { version: 1, profiles: {} },
    });
    expect(params.hasAuthForProvider?.("acme")).toBe(true);
    expect(params.context.hasAuthForProvider?.("acme")).toBe(true);
    await expect(params.context.resolveApiKeyForProvider?.("acme")).resolves.toBe("env-only-key");
  });

  it("keeps ordered profile precedence when runtime auth is also available", async () => {
    vi.stubEnv("ACME_API_KEY", "env-key");
    const params = resolveTools({
      config: { ...authConfig("ACME_API_KEY"), auth: { order: { acme: ["acme:profile"] } } },
      agentDir: TEST_AGENT_DIR,
      authProfileStore: {
        version: 1,
        profiles: {
          "acme:profile": {
            type: "api_key",
            provider: "acme",
            key: "profile-key", // pragma: allowlist secret
          },
        },
      },
    });
    expect(params.hasAuthForProvider?.("acme")).toBe(true);
    expect(params.context.hasAuthForProvider?.("acme")).toBe(true);
    await expect(params.context.resolveApiKeyForProvider?.("acme")).resolves.toBe("profile-key");
  });

  it("keeps the plugin tool getter live across authored source reloads", () => {
    const sourceConfig: OpenClawConfig = {
      gateway: { publicOrigin: "https://first.example" },
      plugins: { allow: ["memory-core"] },
    };
    const firstRuntimeConfig: OpenClawConfig = {
      ...sourceConfig,
      plugins: { ...sourceConfig.plugins, entries: { "memory-core": { enabled: true } } },
    };
    const nextSourceConfig: OpenClawConfig = {
      ...sourceConfig,
      gateway: { publicOrigin: "https://second.example" },
    };
    const nextRuntimeConfig: OpenClawConfig = { ...firstRuntimeConfig, ...nextSourceConfig };
    setRuntimeConfigSnapshot(firstRuntimeConfig, sourceConfig);
    const { getRuntimeConfig } = resolveTools({ config: sourceConfig }).context;
    expect(getRuntimeConfig?.()).toBe(firstRuntimeConfig);
    setRuntimeConfigSnapshot(nextRuntimeConfig, nextSourceConfig);
    expect(getRuntimeConfig?.()).toBe(nextRuntimeConfig);
    expect(getRuntimeConfig?.()?.gateway?.publicOrigin).toBe("https://second.example");
  });
});

function requirePluginTool(overrides: Parameters<typeof createOpenClawTools>[0]) {
  const name = "synthetic_direct_cron_plugin";
  hoisted.resolvePluginTools.mockReturnValue([
    {
      name,
      label: "Synthetic direct cron plugin",
      description: "Calls Gateway cron directly like plugin-owned reminder tools.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const { getGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js");
        observedGatewayCallerIdentities.push(getGatewayToolCallerIdentity());
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    },
  ]);
  const tool = createOpenClawTools({
    agentSessionKey: "agent:main:discord:channel:123",
    disableMessageTool: true,
    pluginToolAllowlist: [name],
    requesterAgentIdOverride: "main",
    wrapBeforeToolCallHook: false,
    ...overrides,
  }).find((candidate) => candidate.name === name);
  if (!tool?.execute) {
    throw new Error(`Expected executable tool ${name}`);
  }
  return tool;
}

describe("createOpenClawTools Gateway caller identity", () => {
  it("carries trusted turn-source routing with the agent identity", async () => {
    const tool = requirePluginTool({
      agentChannel: "discord",
      agentTo: "channel:123",
      agentAccountId: "work",
      agentThreadId: "thread-7",
    });
    await tool.execute("tool-call-2", {});
    expect(observedGatewayCallerIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "work",
        turnSourceThreadId: "thread-7",
      },
    ]);
  });

  it("uses scheduled creator account authority without changing live delivery routing", async () => {
    const tool = requirePluginTool({
      agentChannel: "discord",
      agentTo: "channel:123",
      agentAccountId: "delivery-account",
      gatewayCallerAccountId: "creator-account",
    });
    await tool.execute("tool-call-scheduled", {});
    expect(observedGatewayCallerIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "creator-account",
      },
    ]);
  });
});
