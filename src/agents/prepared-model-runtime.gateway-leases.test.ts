// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  usePreparedModelRuntimeHarness,
  getPreparedModelRuntimeTestApi,
} from "./prepared-model-runtime.test-harness.js";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireAgentRuntimeCleanupRegistries,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

describe("prepared model runtime Gateway leases", () => {
  it("borrows a configured generation for another model but builds for an uncovered provider", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {
      agents: { defaults: { model: "configured-provider/primary" } },
      plugins: {
        slots: { memory: "none" },
        entries: {
          "configured-plugin": { enabled: true },
          "additional-plugin": { enabled: true },
        },
      },
    };
    const configuredRegistry = createEmptyPluginRegistry();
    configuredRegistry.plugins.push(
      createPluginRecord({ id: "configured-plugin", imported: true }),
    );
    const additionalRegistry = createEmptyPluginRegistry();
    additionalRegistry.plugins.push(
      createPluginRecord({ id: "additional-plugin", imported: true }),
    );
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
      params.selections?.some(
        (selection: { provider: string }) => selection.provider === "additional-provider",
      )
        ? additionalRegistry
        : configuredRegistry,
    );
    const metadata = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([
        {
          id: "configured-plugin",
          origin: "bundled",
          channels: [],
          providers: ["configured-provider"],
        },
        {
          id: "additional-plugin",
          origin: "bundled",
          channels: [],
          providers: ["additional-provider"],
        },
      ]),
    });
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      pluginMetadataSnapshot: {
        ...metadata,
        owners: {
          ...metadata.owners,
          providers: new Map([
            ["configured-provider", ["configured-plugin"]],
            ["additional-provider", ["additional-plugin"]],
          ]),
        },
      },
    });
    const published = expectDefined(
      await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      "configured dispatch runtime",
    );
    const input = {
      config,
      agentId: "default",
      agentDir: published.agentDir,
      workspaceDir: published.workspaceDir,
    };
    const configured = expectDefined(getPreparedModelRuntimeSnapshot(input), "configured snapshot");
    const loadsBeforeRun = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
    await using covered = await acquireAgentRunPreparedModelRuntime({
      ...input,
      runtimePluginSelections: [
        { provider: "configured-provider", modelId: "utility", runtime: "openclaw" },
      ],
    });
    expect(covered.snapshot).toBe(configured);
    expect(covered.pluginGeneration).toBe(published.pluginGeneration);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(loadsBeforeRun);

    await using uncovered = await acquireAgentRunPreparedModelRuntime({
      ...input,
      runtimePluginSelections: [
        { provider: "additional-provider", modelId: "utility", runtime: "openclaw" },
      ],
    });
    expect(uncovered.snapshot).not.toBe(configured);
    expect(uncovered.pluginGeneration).not.toBe(published.pluginGeneration);
    expect(uncovered.snapshot.pluginRegistry).toBe(additionalRegistry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(loadsBeforeRun + 1);
    expect(getPreparedModelRuntimeSnapshot(input)).toBe(configured);
    expect(await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).toBe(published);
  });

  it("bounds retained gateway run owners while reusing recent selections", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const acquire = async (modelId: string) => {
      const lease = await acquireAgentRunPreparedModelRuntime({
        agentId: "default",
        agentDir: fixture.state.agentDir("default"),
        config,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "openai", modelId, runtime: "codex" }],
        workspaceDir: "/tmp/unused-workspace",
      });
      await lease[Symbol.asyncDispose]();
      return lease.snapshot;
    };

    const first = await acquire("run-model-0");
    for (let index = 1; index < 9; index += 1) {
      await acquire(`run-model-${index}`);
    }
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(11);

    const rebuilt = await acquire("run-model-0");
    expect(rebuilt).not.toBe(first);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(12);
  });

  it("retains switched-away execution registries for agent-scoped session cleanup", async () => {
    mocks.configuredAgentIds = ["default"];
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() =>
      createEmptyPluginRegistry(),
    );
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const previous = [];
    for (const modelId of ["first", "second"]) {
      await using lease = await acquireAgentRunPreparedModelRuntime({
        agentId: "default",
        agentDir: fixture.state.agentDir("default"),
        config,
        loadRuntimePlugins: true,
        workspaceDir: fixture.state.workspaceDir,
        runtimePluginSelections: [{ provider: "openai", modelId, runtime: "codex" }],
      });
      previous.push(lease.snapshot.pluginRegistry);
    }
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();
    await using cleanup = await acquireAgentRuntimeCleanupRegistries(
      fixture.state.agentDir("default"),
    );
    for (const registry of previous) {
      expect(cleanup.registries).toContain(registry);
    }
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
    await using unrelated = await acquireAgentRuntimeCleanupRegistries(
      fixture.state.agentDir("other"),
    );
    expect(unrelated.registries).toEqual([]);
  });

  it("never evicts a configured owner acquired through the gateway run path", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const configuredInput = {
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      config,
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
      workspaceDir: "/tmp/unused-workspace",
    };
    const configured = getPreparedModelRuntimeSnapshot(configuredInput);
    const configuredLease = await acquireAgentRunPreparedModelRuntime(configuredInput);
    expect(configuredLease.snapshot).toBe(configured);
    await configuredLease[Symbol.asyncDispose]();

    for (let index = 0; index < 9; index += 1) {
      const lease = await acquireAgentRunPreparedModelRuntime({
        ...configuredInput,
        loadRuntimePlugins: true,
        runtimePluginSelections: [
          { provider: "openai", modelId: `run-model-${index}`, runtime: "codex" },
        ],
      });
      await lease[Symbol.asyncDispose]();
    }

    expect(getPreparedModelRuntimeSnapshot(configuredInput)).toBe(configured);
  });

  it("retires released retained run owners when gateway refresh clears the lifecycle", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    for (let index = 0; index < 3; index += 1) {
      const lease = await acquireAgentRunPreparedModelRuntime({
        agentId: "default",
        agentDir: fixture.state.agentDir("default"),
        config,
        loadRuntimePlugins: true,
        runtimePluginSelections: [
          { provider: "openai", modelId: `retained-model-${index}`, runtime: "codex" },
        ],
        workspaceDir: "/tmp/unused-workspace",
      });
      await lease[Symbol.asyncDispose]();
    }
    expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(4);

    const refreshError = new Error("configured owner discovery failed");
    mocks.configuredAgentIdsError = refreshError;
    await expect(refreshPreparedModelRuntimeSnapshots(config)).rejects.toBe(refreshError);

    expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
  });
});
