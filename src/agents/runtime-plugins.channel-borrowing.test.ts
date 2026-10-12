import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { acquirePluginRegistryForInspection, loadOpenClawPlugins } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
  writePluginMetadata,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { getPluginRegistryRuntime } from "../plugins/registry-runtime-binding.js";
import { createPluginRegistryOwner, getActivePluginRegistry } from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { prepareWorkspacePluginRegistries } from "./prepared-model-runtime.inbound-registry.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const channelId = "borrowed-channel";
const freshId = "prepared-only";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["direct-loader-successor", "prepared"] as const)(
  "revokes borrowed channel methods and read grants through %s without retiring the lender",
  async (producer) => {
    const root = tempDirs.make("openclaw-channel-borrowing-");
    const bundledDir = path.join(root, "bundled");
    const workspaceDir = path.join(root, "workspace");
    const channel = writePlugin({
      id: channelId,
      dir: path.join(bundledDir, channelId),
      filename: "index.cjs",
      registration: `const owner = api.config.agents.defaults.model;
        api.registerChannel({ plugin: {
          id: "borrowed-channel",
          meta: { id: "borrowed-channel", label: "Borrowed", selectionLabel: "Borrowed",
            docsPath: "/channels/fixture", blurb: "Borrowed channel fixture" },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
          outbound: { deliveryMode: "direct",
            async sendText() { return { channel: "borrowed-channel", messageId: owner }; } },
        } });`,
    });
    writePluginMetadata({ dir: channel.dir, id: channelId, channels: [channelId] });
    writePlugin({
      id: freshId,
      dir: path.join(bundledDir, freshId),
      filename: "index.cjs",
      registration: "",
    });
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    const config: OpenClawConfig = {
      agents: { defaults: { model: "fixture/gateway" } },
      plugins: {
        allow: [channelId, freshId],
        entries: { [channelId]: { enabled: true }, [freshId]: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    const metadata = loadPluginMetadataSnapshot({ config, workspaceDir });
    const options = {
      config,
      workspaceDir,
      manifestRegistry: metadata.manifestRegistry,
      discovery: metadata.discovery,
      preferBuiltPluginArtifacts: true,
      runtimeOptions: { allowGatewaySubagentBinding: true },
    };
    const loadGateway = () => {
      const registry = loadOpenClawPlugins({
        ...options,
        onlyPluginIds: [channelId],
        activate: false,
        runtimeSideEffects: true,
        cache: false,
      });
      const runtime = getPluginRegistryRuntime(registry);
      if (!runtime) {
        throw new Error("Expected a loaded Gateway runtime");
      }
      bindGatewayContextResolver(runtime, () => undefined);
      activatePluginRegistry(registry, null, "gateway-bindable", workspaceDir);
      return createPluginRegistryOwner(registry, workspaceDir);
    };
    const gateway = loadGateway();
    try {
      const liveRecord = gateway.registry.plugins.find((record) => record.id === channelId)!;
      const liveInstance = getPluginInstance(liveRecord)!;
      const liveEntry = gateway.registry.channels[0]!;
      expect(liveRecord).toMatchObject({ status: "loaded", origin: "bundled" });
      expect(liveEntry.captureReadAuthority?.()?.()).toBe(true);
      expect(getActivePluginRegistry()).toBe(gateway.registry);
      await using buildResources = new PreparedModelRuntimeBuildResources(
        retainPreparedPluginRegistry,
      );
      const acquired = await withPluginRuntimeRegistryScope(gateway.registry, async () => {
        if (producer === "direct-loader-successor") {
          const previous = await acquirePluginRegistryForInspection({
            ...options,
            onlyPluginIds: [channelId],
            borrowRegistry: gateway.registry,
          });
          try {
            return await acquirePluginRegistryForInspection({
              ...options,
              previousRegistry: previous?.registry,
              borrowRegistry: gateway.registry,
            });
          } finally {
            await previous?.release();
          }
        }
        const prepared = await prepareWorkspacePluginRegistries(
          { config, workspaceDir, agentDir: workspaceDir, allowGatewaySubagentBinding: true },
          metadata,
          (registry) => buildResources.retainRegistry(registry),
          undefined,
          true,
          undefined,
          () => [],
          [channelId, freshId],
          buildResources.load.bind(buildResources),
        );
        if (!prepared.runtimePluginRegistry) {
          throw new Error("Expected a prepared registry");
        }
        return {
          registry: prepared.runtimePluginRegistry,
          release: () => buildResources[Symbol.asyncDispose](),
        };
      });
      const resources = getPluginRegistryInspectionResources(acquired.registry)!;
      const scope = resources.createInvocationScope(acquired.registry);
      try {
        // Both producers borrow the live record rather than another discovery copy.
        expect(acquired.registry.plugins.find((record) => record.id === channelId)).toBe(
          liveRecord,
        );
        expect(liveInstance.owner?.registry).toBe(gateway.registry);
        const freshRecord = acquired.registry.plugins.find((record) => record.id === freshId)!;
        expect(freshRecord.status).toBe("loaded");
        const freshInstance = getPluginInstance(freshRecord)!;
        const entry = acquired.registry.channels[0]!;
        const capture = entry.captureReadAuthority!;
        const grant = capture();
        const send = entry.plugin.outbound!.sendText!;
        const scopedCapture = scope.wrap(capture);
        const scopedGrant = scopedCapture();
        const scopedSend = scope.wrap(entry.plugin).outbound!.sendText!;
        const resolveRuntime = scope.wrap(entry.resolveChannelRuntime);
        const sendParams = { cfg: config, to: "fixture-room", text: "fixture message" };
        expect(grant?.()).toBe(true);
        expect(scopedGrant?.()).toBe(true);
        await expect(scopedSend(sendParams)).resolves.toMatchObject({
          messageId: "fixture/gateway",
        });
        scope.release();
        expect(() => scopedSend(sendParams)).toThrow("consumer is closed");
        expect.soft(() => scopedCapture()).toThrow("consumer is closed");
        expect.soft(() => scopedGrant?.()).toThrow("consumer is closed");
        expect.soft(() => resolveRuntime?.()).toThrow();
        await acquired.release();
        expect.soft(() => capture()).toThrow();
        expect.soft(() => grant?.()).toThrow();
        expect.soft(() => send(sendParams)).toThrow();
        expect(freshInstance.acceptingCalls).toBe(false);
        expect(liveInstance.owner?.registry).toBe(gateway.registry);
        expect(liveInstance.acceptingCalls).toBe(true);
        expect(liveInstance.disposing).toBe(false);
        expect(liveInstance.hasRetainedConsumers).toBe(false);
        expect(liveEntry.captureReadAuthority?.()?.()).toBe(true);
        await expect(liveEntry.plugin.outbound!.sendText!(sendParams)).resolves.toMatchObject({
          messageId: "fixture/gateway",
        });
      } finally {
        scope.release();
        await acquired.release();
      }
    } finally {
      await gateway.close();
    }
  },
);
