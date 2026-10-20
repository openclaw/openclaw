// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  acquireAgentRunPreparedModelRuntime as acquire,
  acquireAgentRuntimeCleanupRegistries as acquireCleanup,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  refreshPreparedModelRuntimeSnapshots as refresh,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

beforeEach(() => {
  mocks.configuredAgentIds = ["default"];
});

async function publishGateway() {
  const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
  await refresh(config, {
    catalogMode: "static",
    gatewayLifecycle: true,
  });
  return {
    agentId: "default",
    agentDir: fixture.state.agentDir("default"),
    config,
    workspaceDir: "/tmp/unused-workspace",
  };
}

it("borrows a configured generation for another model but builds for an uncovered provider", async () => {
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
  configuredRegistry.plugins.push(createPluginRecord({ id: "configured-plugin", imported: true }));
  const additionalRegistry = createEmptyPluginRegistry();
  additionalRegistry.plugins.push(createPluginRecord({ id: "additional-plugin", imported: true }));
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
    params.selections?.some(
      (selection: { provider: string }) => selection.provider === "additional-provider",
    )
      ? additionalRegistry
      : configuredRegistry,
  );
  const metadata = createPluginMetadataSnapshot({
    config,
    manifestRegistry: makeRegistry(
      ["configured", "additional"].map((name) => ({
        id: `${name}-plugin`,
        origin: "bundled",
        channels: [],
        providers: [`${name}-provider`],
      })),
    ),
  });
  await refresh(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    pluginMetadataSnapshot: {
      ...metadata,
      owners: {
        ...metadata.owners,
        providers: new Map(
          ["configured", "additional"].map((name) => [`${name}-provider`, [`${name}-plugin`]]),
        ),
      },
    },
  });
  const published = expectDefined(
    await loadDispatch({ agentId: "default" }),
    "configured dispatch runtime",
  );
  const input = {
    config,
    agentId: "default",
    agentDir: published.agentDir,
    workspaceDir: published.workspaceDir,
  };
  const configured = expectDefined(readSnapshot(input), "configured snapshot");
  const loadsBeforeRun = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
  for (const workspaceDir of [input.workspaceDir, "/tmp/outside-folder"]) {
    await using covered = await acquire({
      ...input,
      workspaceDir,
      runtimePluginSelections: [
        { provider: "configured-provider", modelId: "utility", runtime: "openclaw" },
      ],
    });
    expect(covered.snapshot).toBe(configured);
    expect(covered.pluginGeneration).toBe(published.pluginGeneration);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(loadsBeforeRun);
  }

  await using uncovered = await acquire({
    ...input,
    workspaceDir: "/tmp/outside-folder",
    runtimePluginSelections: [
      { provider: "additional-provider", modelId: "utility", runtime: "openclaw" },
    ],
  });
  expect(uncovered.snapshot).not.toBe(configured);
  expect(uncovered.pluginGeneration).not.toBe(published.pluginGeneration);
  expect(uncovered.snapshot.pluginRegistry).toBe(additionalRegistry);
  expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(loadsBeforeRun + 1);
  expect(readSnapshot(input)).toBe(configured);
  expect(await loadDispatch({ agentId: "default" })).toBe(published);
});

it("evicts old idle gateway run owners while reusing recent selections", async () => {
  const input = await publishGateway();
  const acquireModel = async (modelId: string) => {
    await using lease = await acquire({
      ...input,
      loadRuntimePlugins: true,
      runtimePluginSelections: [{ provider: "openai", modelId, runtime: "codex" }],
    });
    return lease.snapshot;
  };

  const first = await acquireModel("run-model-0");
  for (let index = 1; index < 8; index += 1) {
    await acquireModel(`run-model-${index}`);
  }
  const recent = await acquireModel("run-model-8");
  expect(await acquireModel("run-model-8")).toBe(recent);
  expect(await acquireModel("run-model-0")).not.toBe(first);
});

it("retains switched-away execution registries for agent-scoped session cleanup", async () => {
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => createEmptyPluginRegistry());
  const input = await publishGateway();
  const previous = [];
  for (const modelId of ["first", "second"]) {
    await using lease = await acquire({
      ...input,
      loadRuntimePlugins: true,
      workspaceDir: fixture.state.workspaceDir,
      runtimePluginSelections: [{ provider: "openai", modelId, runtime: "codex" }],
    });
    previous.push(lease.snapshot.pluginRegistry);
  }
  mocks.loadAgentRuntimePluginRegistryHandle.mockClear();
  await using cleanup = await acquireCleanup(fixture.state.agentDir("default"));
  for (const registry of previous) {
    expect(cleanup.registries).toContain(registry);
  }
  expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  await using unrelated = await acquireCleanup(fixture.state.agentDir("other"));
  expect(unrelated.registries).toEqual([]);
});
