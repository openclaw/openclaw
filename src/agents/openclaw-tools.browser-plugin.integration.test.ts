import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { ChannelOutboundContext } from "../channels/plugins/outbound.types.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
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
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { OpenClawPluginToolDelivery } from "../plugins/tool-types.js";
import type { resolvePluginTools } from "../plugins/tools.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawTools, createOpenClawToolsAsync } from "./openclaw-tools.js";
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
const identity = {
  agentId: "main",
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: SESSION_KEY,
};
const deliveryOptions = {
  agentSessionKey: SESSION_KEY,
  runId: identity.runId,
  sessionId: identity.sessionId,
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
    ...identity,
    ...overrides,
  });
  capabilities.push(token);
  return token;
}

function installChannel(input: ReturnType<typeof createOutboundTestPlugin>, accounts?: string[]) {
  let plugin = input;
  if (accounts) {
    plugin = {
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => accounts, resolveAccount: () => ({}) },
    };
  }
  const registry = createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]);
  setActivePluginRegistry(registry);
  return registry;
}

function firstResolvePluginToolsParams() {
  return expectDefined(hoisted.resolvePluginTools.mock.calls[0], "Expected plugin resolution")[0];
}

function buildDeliveryTools(options: Parameters<typeof createOpenClawTools>[0]) {
  return createOpenClawTools({ ...deliveryOptions, ...options });
}

function telegramPlugin(outbound: Partial<ChannelOutboundAdapter> = {}) {
  return createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "telegram", messageId: "sent-1" }),
      ...outbound,
    },
  });
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
  // Exercise auth-source preparation even on hosts with configured search providers.
  for (const name of listKnownProviderAuthEnvVarNamesCore({ config: {} })) {
    vi.stubEnv(name, undefined);
  }
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
  it("awaits account discovery before publishing message actions and schema", async () => {
    const enteredDiscovery = createDeferred();
    const releaseDiscovery = createDeferred();
    const describeMessageTool = vi.fn(() => ({ actions: [] }));
    const describeMessageToolAsync = vi.fn(async () => {
      enteredDiscovery.resolve();
      await releaseDiscovery.promise;
      return {
        actions: ["send", "react"] as const,
        capabilities: ["delivery-pin"] as const,
        schema: { properties: { reactionKind: Type.Optional(Type.String()) } },
      };
    });
    installChannel({
      ...createChannelTestPluginBase({ id: "matrix" }),
      actions: {
        describeMessageTool,
        describeMessageToolAsync,
      },
    });
    const publish = vi.fn((tools: Awaited<ReturnType<typeof createOpenClawToolsAsync>>) => tools);
    const pending = createOpenClawToolsAsync({
      config: { tools: { web: { search: { enabled: false }, fetch: { enabled: false } } } },
      agentChannel: "matrix",
      agentAccountId: "work",
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    }).then(publish);
    await awaitGateBeforeSettlement(
      enteredDiscovery.promise,
      pending,
      "Message tool construction skipped asynchronous account discovery",
    );
    expect(publish).not.toHaveBeenCalled();
    releaseDiscovery.resolve();
    const message = (await pending).find((tool) => tool.name === "message");
    expect(message?.description).toContain("react");
    expect(message?.parameters).toMatchObject({
      properties: {
        action: { enum: expect.arrayContaining(["react"]) },
        reactionKind: { type: "string" },
        delivery: { type: "object", properties: { pin: expect.any(Object) } },
      },
    });
    expect(describeMessageTool).not.toHaveBeenCalled();
    expect(describeMessageToolAsync).toHaveBeenCalledOnce();
  });

  it.each([SESSION_KEY, undefined])("binds delivery for %s", async (key) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-delivery-"));
    const mediaUrl = path.join(workspaceDir, "photo.png");
    const outsideMediaUrl = `${workspaceDir}-outside.png`;
    await fs.copyFile(
      new URL(
        "../../apps/ios/WatchApp/Assets.xcassets/OpenClawIcon.imageset/openclaw-icon.png",
        import.meta.url,
      ),
      mediaUrl,
    );
    await fs.copyFile(mediaUrl, outsideMediaUrl);
    const platformSendMedia = vi.fn(async () => ({ channel: "telegram", messageId: "sent-1" }));
    const transportDispatchStarted = createDeferred();
    const resumeTransportDispatch = createDeferred();
    let deferTransportDispatch = false;
    const sendMedia = vi.fn(async (params: ChannelOutboundContext) => {
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
    });
    const providerNativeSend = vi.fn(async () => jsonResult({ ok: true, native: true }));
    const plugin = telegramPlugin({ sendMedia });
    plugin.messaging = {
      normalizeTarget: (raw) => raw,
      targetResolver: { looksLikeId: () => true, hint: "<chat-id>" },
    };
    plugin.actions = { describeMessageTool: () => null, handleAction: providerNativeSend };
    const activeRegistry = installChannel(plugin, ["work", "attacker-account"]);
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
    const bindTurn = (run: number, authority: Parameters<typeof mintTurn>[0] = {}) => {
      const runId = `run-${run}`;
      const sessionId = `session-${run}`;
      const token = mintTurn({
        runId,
        sessionId,
        sessionKey: key ?? "agent:main:main",
        sourceReplySessionKey: "agent:main:main",
        ...authority,
      });
      buildDeliveryTools({
        config,
        workspaceDir,
        agentSessionKey: key,
        runSessionKey: "agent:main:main",
        runId,
        sessionId,
        agentThreadId: run === 1 ? "7" : undefined,
        messageActionTurnCapability: token,
      });
      return { token, delivery: expectDefined(delivery, "expected plugin delivery capability") };
    };
    const inactive = "plugin delivery capability is no longer active";
    try {
      const { token: turnCapability, delivery: activeDelivery } = bindTurn(1, {
        requesterAccountId: "work",
        requesterSenderId: "sender-1",
        toolContext: {
          currentChannelId: "123",
          currentMessagingTarget: "123",
          currentChannelProvider: "telegram",
          currentThreadTs: "7",
        },
      });
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
      await expect(pending).rejects.toThrow(inactive);
      expect(platformSendMedia).toHaveBeenCalledTimes(1);
      expect(providerNativeSend).not.toHaveBeenCalled();
      await expect(activeDelivery.send({ text: "too late" })).rejects.toThrow(inactive);
      expect(platformSendMedia).toHaveBeenCalledTimes(1);
      const { delivery: replacementDelivery } = bindTurn(2);
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect(replacementDelivery.send({ text: "stale registry" })).rejects.toThrow(inactive);
      setActivePluginRegistry(activeRegistry);
      await expect(replacementDelivery.send({ text: "reactivated registry" })).rejects.toThrow(
        inactive,
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
    const caller = { ...identity, runId: "cli-message-only", sessionId: "session-cli" };
    const token = mintTurn({
      ...caller,
      requesterAccountId: "work",
      requesterSenderId: "sender-1",
    });
    const cfg: OpenClawConfig = { tools: { allow: ["message"] } };
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(createEmptyPluginRegistry());
    await resolveGatewayScopedTools({
      ...caller,
      cfg,
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
    "does not delegate %s announce-route authority to plugins",
    (kind) => {
      const sessionKey = "agent:main:cron:scheduled-plugin-delivery";
      installChannel(telegramPlugin(), ["work"]);
      const scheduledIdentity = { runId: "scheduled-message-run", sessionId: "session-cron" };
      const token = mintTurn({
        ...scheduledIdentity,
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
      buildDeliveryTools({
        ...scheduledIdentity,
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
    buildDeliveryTools({
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
    expectDefined(loadContext, "expected prepared plugin load context");
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

  it.each(["environment", "profile", "plugin"] as const)(
    "resolves %s auth without borrowing excluded credentials",
    async (source) => {
      const envOnly = source === "environment";
      const envName = envOnly ? "OPENCLAW_PLUGIN_TOOL_AUTH_TEST_KEY" : "ACME_API_KEY";
      if (source !== "plugin") {
        vi.stubEnv(envName, envOnly ? "env-only-key" : "env-key");
      }
      const config = authConfig(envName);
      if (!envOnly) {
        config.auth = { order: { acme: ["acme:profile"] } };
      }
      const check = async () => {
        const params = resolveTools({
          config,
          agentDir: TEST_AGENT_DIR,
          ...(envOnly ? { workspaceDir: "/workspace" } : {}),
          authProfileStore: {
            version: 1,
            profiles: envOnly
              ? {}
              : {
                  "acme:profile": { type: "api_key", provider: "acme", key: "profile-key" }, // pragma: allowlist secret
                },
          },
        });
        expect(params.hasAuthForProvider?.("acme")).toBe(source !== "plugin");
        expect(params.context.hasAuthForProvider?.("acme")).toBe(source !== "plugin");
        await expect(params.context.resolveApiKeyForProvider?.("acme")).resolves.toBe(
          source === "plugin" ? undefined : envOnly ? "env-only-key" : "profile-key",
        );
      };
      if (source !== "plugin") {
        return await check();
      }
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "acme",
            providers: ["acme"],
            modelCatalog: { providers: { acme: { authScope: "plugin", models: [] } } },
          },
        ],
      });
      await withPluginMetadataSnapshotScope(metadata, check, { config, trustConfigIdentity: true });
    },
  );

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
    config: {},
    requesterAgentIdOverride: "main",
    wrapBeforeToolCallHook: false,
    ...overrides,
  }).find((candidate) => candidate.name === name);
  return expectDefined(tool, `Expected executable tool ${name}`);
}

describe("createOpenClawTools Gateway caller identity", () => {
  it.each([
    [
      { agentAccountId: "work", agentThreadId: "thread-7" },
      { turnSourceAccountId: "work", turnSourceThreadId: "thread-7" },
    ],
    [
      { agentAccountId: "delivery-account", gatewayCallerAccountId: "creator-account" },
      { turnSourceAccountId: "creator-account" },
    ],
  ] as const)("binds trusted caller routing for %j", async (options, expected) => {
    await requirePluginTool({
      agentChannel: "discord",
      agentTo: "channel:123",
      ...options,
    }).execute("caller", {});
    expect(observedGatewayCallerIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        ...expected,
      },
    ]);
  });
});
