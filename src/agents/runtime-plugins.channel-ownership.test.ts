import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  loadPluginRegistryHandle: vi.fn(),
  acquirePluginRegistryForInspection: vi.fn(),
}));
vi.mock("../plugins/loader.js", () => loaders);

import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import {
  collectRegistryInvocationInstances,
  PluginInvocationScope,
} from "../plugins/plugin-invocation-scope.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadPreparedInboundPluginRegistry } from "./prepared-model-runtime.inbound-registry.js";
import {
  acquireAgentRuntimePluginRegistry,
  loadAgentRuntimePluginRegistryHandle,
} from "./runtime-plugins.js";

const pluginId = "prepared-channel";
const manifests = makeRegistry([{ id: pluginId, channels: [pluginId], origin: "bundled" }]);
const config: OpenClawConfig = {
  plugins: { allow: [pluginId], slots: { memory: "none" } },
};
const nextConfig: OpenClawConfig = { ...config, channels: { matrix: { streaming: "quiet" } } };
const sendParams = { cfg: nextConfig, to: "fixture-room", text: "fixture message" };
let previous: ReturnType<typeof captureActivePluginRegistrySnapshot>;
const instances: PluginInstanceHandle[] = [];
const releases: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  previous = captureActivePluginRegistrySnapshot();
  loaders.loadPluginRegistryHandle.mockReset();
  loaders.acquirePluginRegistryForInspection.mockReset();
});

afterEach(async () => {
  for (const release of releases.splice(0).toReversed()) {
    await release();
  }
  restoreActivePluginRegistrySnapshot(previous);
  const disposed = await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  for (const result of disposed) {
    expect(result.errors).toEqual([]);
  }
});

function createChannelOwner(
  marker: string,
  gateway: GatewayContextResolver,
  options: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    manifestRegistry?: PluginManifestRegistry;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const subagent: PluginRuntime["subagent"] = {
    complete: vi.fn<PluginRuntime["subagent"]["complete"]>(),
    run: vi.fn<PluginRuntime["subagent"]["run"]>(),
    waitForRun: vi.fn<PluginRuntime["subagent"]["waitForRun"]>(),
    getSessionMessages: vi.fn<PluginRuntime["subagent"]["getSessionMessages"]>(),
    deleteSession: vi.fn<PluginRuntime["subagent"]["deleteSession"]>(),
  };
  bindGatewayContextResolver(subagent, gateway);
  const runtime = createPluginRuntime({ subagent });
  bindGatewayContextResolver(runtime, gateway);
  const builder = createTestPluginRegistry(runtime);
  const manifestRegistry = options.manifestRegistry ?? manifests;
  const manifest = manifestRegistry.plugins[0]!;
  const record = createPluginRecord({
    id: pluginId,
    rootDir: manifest.rootDir,
    source: manifest.source,
    origin: "bundled",
    format: "openclaw",
    imported: true,
  });
  bindPluginRuntimeArtifactSelection(record, {
    preferBuiltPluginArtifacts: true,
    runtimeEntry: resolvePluginRuntimeArtifactSelection({
      ...manifest,
      entryKind: "runtime",
      preferBuiltPluginArtifacts: true,
    }),
  });
  const ownerConfig = options.config ?? config;
  const api = builder.createApi(record, { config: ownerConfig, registrationMode: "full" });
  const send = vi.fn(async () => ({ channel: pluginId, messageId: marker }));
  api.registerChannel({
    plugin: {
      id: pluginId,
      meta: {
        id: pluginId,
        label: pluginId,
        selectionLabel: pluginId,
        docsPath: "/channels/fixture",
        blurb: "Owned channel fixture",
      },
      capabilities: { chatTypes: ["direct"] },
      config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
      outbound: { deliveryMode: "direct", sendText: send },
    },
  });
  builder.registry.plugins.push(record);
  const instance = getPluginInstance(record)!;
  instances.push(instance);
  const workspaceDir = options.workspaceDir ?? "/fixture/gateway";
  const metadataSnapshot = createPluginMetadataSnapshot({
    config: ownerConfig,
    workspaceDir,
    manifestRegistry,
  });
  setPluginRuntimeLoadContext(builder.registry, {
    rawConfig: ownerConfig,
    config: ownerConfig,
    activationSourceConfig: ownerConfig,
    autoEnabledReasons: {},
    workspaceDir,
    env: options.env ?? process.env,
    manifestRegistry,
    metadataSnapshot,
    preferBuiltPluginArtifacts: true,
    logger: { info() {}, warn() {}, error() {} },
  });
  return {
    ...builder,
    record,
    instance,
    send,
    metadataSnapshot,
    workspaceDir,
    config: ownerConfig,
  };
}

function prepareOwners() {
  const gateway: GatewayContextResolver = () => undefined;
  const live = createChannelOwner("live transport", gateway, { env: { ...process.env } });
  const selected = createChannelOwner("discovery transport", gateway, {
    config: nextConfig,
    workspaceDir: "/fixture/another-agent",
  });
  setActivePluginRegistry(live.registry, "live", "gateway-bindable", live.workspaceDir);
  loaders.loadPluginRegistryHandle.mockReturnValue(selected.registry);
  const input = {
    config: nextConfig,
    metadataSnapshot: selected.metadataSnapshot,
    workspaceDir: selected.workspaceDir,
    allowGatewaySubagentBinding: true,
    preferBuiltPluginArtifacts: true,
  };
  return { gateway, live, selected, input };
}

describe("prepared channel runtime ownership", () => {
  it.each(["inbound", "selected"] as const)(
    "keeps the live transport after config-only reload through the %s producer",
    async (path) => {
      const { live, selected, input } = prepareOwners();
      const registry = withPluginRuntimeRegistryScope(live.registry, () =>
        path === "inbound"
          ? loadPreparedInboundPluginRegistry(input, selected.metadataSnapshot)
          : loadAgentRuntimePluginRegistryHandle(input),
      );
      const scope = new PluginInvocationScope(
        registry,
        collectRegistryInvocationInstances(registry),
        {
          retained: true,
        },
      );
      releases.push(() => scope.release());
      const entry = registry.channels[0]!;
      const send = scope.wrap(entry.plugin).outbound!.sendText!;
      const grant = scope.wrap(entry.captureReadAuthority)?.();
      const resolveRuntime = scope.wrap(entry.resolveChannelRuntime);
      expect(grant?.()).toBe(true);
      await expect(send(sendParams)).resolves.toMatchObject({ messageId: "live transport" });
      expect(selected.send).not.toHaveBeenCalled();
      scope.release();
      expect(live.instance.acceptingCalls).toBe(true);
      expect(() => send(sendParams)).toThrow("consumer is closed");
      expect(() => grant?.()).toThrow("consumer is closed");
      expect(() => resolveRuntime?.()).toThrow("consumer is closed");
      await expect(
        live.registry.channels[0]!.plugin.outbound!.sendText!(sendParams),
      ).resolves.toMatchObject({
        messageId: "live transport",
      });
    },
  );

  it("holds the donor through acquired inspection and closes only its scoped callbacks", async () => {
    const { live, selected, input } = prepareOwners();
    const resources = new PluginRegistryInspectionResources(async () => {
      await selected.instance.dispose();
    });
    resources.attach(selected.registry);
    loaders.acquirePluginRegistryForInspection.mockResolvedValue({
      registry: selected.registry,
      release: () => resources.release(),
    });
    const acquired = await withPluginRuntimeRegistryScope(live.registry, () =>
      acquireAgentRuntimePluginRegistry(input),
    );
    if (!("resources" in acquired)) {
      throw new Error("Expected an acquired inspection");
    }
    releases.push(async () => {
      await acquired.releaseRegistry();
      acquired.releaseWork();
    });
    const scope = acquired.resources.createInvocationScope(acquired.registry);
    releases.push(() => scope.release());
    const entry = acquired.registry.channels[0]!;
    const send = scope.wrap(entry.plugin).outbound!.sendText!;
    await expect(send(sendParams)).resolves.toMatchObject({ messageId: "live transport" });
    scope.release();
    await acquired.releaseRegistry();
    acquired.releaseWork();
    expect(() => send(sendParams)).toThrow();
    expect(() => entry.captureReadAuthority?.()).toThrow();
    expect(live.instance.acceptingCalls).toBe(true);
    expect(live.instance.hasRetainedConsumers).toBe(false);
  });

  it("revokes a captured official read grant when the donor retires", () => {
    const { live, input } = prepareOwners();
    const registry = withPluginRuntimeRegistryScope(live.registry, () =>
      loadAgentRuntimePluginRegistryHandle(input),
    );
    const scope = new PluginInvocationScope(
      registry,
      collectRegistryInvocationInstances(registry),
      {
        retained: true,
      },
    );
    releases.push(() => scope.release());
    const grant = scope.wrap(registry.channels[0]!.captureReadAuthority)?.();
    expect(grant?.()).toBe(true);
    markPluginRegistryRetired(live.registry);
    expect(grant?.()).toBe(false);
  });

  it.each(["retired", "replaced"] as const)(
    "refuses a donor %s while registry preparation awaits",
    async (change) => {
      const { gateway, live, selected, input } = prepareOwners();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const resources = new PluginRegistryInspectionResources(async () => {
        await selected.instance.dispose();
      });
      resources.attach(selected.registry);
      loaders.acquirePluginRegistryForInspection.mockImplementation(async () => {
        entered.resolve();
        await resume.promise;
        return { registry: selected.registry, release: () => resources.release() };
      });
      const preparing = withPluginRuntimeRegistryScope(live.registry, () =>
        acquireAgentRuntimePluginRegistry(input),
      ).then((acquired) => {
        if ("releaseRegistry" in acquired) {
          releases.push(async () => {
            await acquired.releaseRegistry();
            acquired.releaseWork();
          });
        }
        return acquired;
      });
      const outcome = expect(preparing).rejects.toThrow("Channel runtime owner changed");
      await entered.promise;
      if (change === "retired") {
        markPluginRegistryRetired(live.registry);
      } else {
        const replacement = createChannelOwner("replacement transport", gateway);
        setActivePluginRegistry(replacement.registry);
      }
      resume.resolve();
      await outcome;
      expect(live.send).not.toHaveBeenCalled();
      expect(selected.send).not.toHaveBeenCalled();
    },
  );

  it.each(["registration", "metadata", "source", "gateway", "caller", "environment"] as const)(
    "does not borrow another transport across a %s mismatch",
    async (mismatch) => {
      const { gateway, live } = prepareOwners();
      const selectedManifests = structuredClone(manifests);
      if (mismatch === "metadata") {
        selectedManifests.plugins[0]!.channels = [pluginId, "another-channel"];
      }
      if (mismatch === "source") {
        selectedManifests.plugins[0]!.source = "/another-workspace/channel/index.js";
        selectedManifests.plugins[0]!.rootDir = "/another-workspace/channel";
      }
      const selected = createChannelOwner(
        "discovery transport",
        mismatch === "gateway" ? () => undefined : gateway,
        {
          config:
            mismatch === "registration"
              ? { plugins: { entries: { [pluginId]: { config: { token: "different-fixture" } } } } }
              : nextConfig,
          manifestRegistry: selectedManifests,
          ...(mismatch === "environment"
            ? { env: { ...process.env, OPENCLAW_STATE_DIR: "/fixture/unrelated-profile" } }
            : {}),
        },
      );
      loaders.loadPluginRegistryHandle.mockReturnValue(selected.registry);
      const registry = withPluginRuntimeGatewayRequestScope(
        {
          isWebchatConnect: () => false,
          pluginRegistry: live.registry,
          ...(mismatch === "caller" ? { resolveGatewayContext: () => undefined } : {}),
        },
        () =>
          loadAgentRuntimePluginRegistryHandle({
            config: selected.config,
            metadataSnapshot: selected.metadataSnapshot,
            allowGatewaySubagentBinding: true,
            preferBuiltPluginArtifacts: true,
          }),
      );
      await expect(
        registry.channels[0]!.plugin.outbound!.sendText!(sendParams),
      ).resolves.toMatchObject({
        messageId: "discovery transport",
      });
      expect(live.send).not.toHaveBeenCalled();
    },
  );
});
