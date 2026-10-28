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
import { createEnteredGate } from "./entered-gate.test-support.js";
import {
  acquireAgentRunPreparedModelRuntime as acquire,
  acquireAgentRuntimeCleanupRegistries as acquireCleanup,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  markPreparedModelRuntimeSnapshotsStale as markStale,
  refreshPreparedModelRuntimeSnapshots as refresh,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

beforeEach(() => {
  mocks.configuredAgentIds = ["default"];
});

it("reprepares run admission when config publication supersedes its unfinished build", async () => {
  const config = { messages: { responsePrefix: "before" } };
  const current = { messages: { responsePrefix: "after" } };
  await refresh(config, { gatewayLifecycle: true, catalogMode: "static" });
  const gate = createEnteredGate();
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    await gate.wait();
    return { entries: [] };
  });
  const admission = acquire({
    ...fixture.agentInput("default", config),
    loadRuntimePlugins: true,
  });
  void admission.catch(() => {});
  let publication: Promise<void> | undefined;
  try {
    await gate.entered;
    publication = refresh(current, { gatewayLifecycle: true, catalogMode: "static" });
    gate.release();
    await publication;
    await using lease = await admission;
    expect(lease.snapshot.config).toEqual(current);
    expect(lease.snapshot.isCurrent()).toBe(true);
    expect((await loadDispatch({ agentId: "default" }))?.config).toEqual(current);
  } finally {
    gate.release();
    await Promise.allSettled([
      publication,
      admission.then((lease) => lease[Symbol.asyncDispose]()),
    ]);
  }
});

it("bounds repeated preparation supersession and leaves ordinary failures untouched", async () => {
  const input = fixture.agentInput("unconfigured", {});
  mocks.prepareStaticCatalog.mockImplementation(async () => {
    markStale("fixture publication changed");
    return { entries: [] };
  });
  await expect(acquire(input)).rejects.toThrow(
    "Model runtime changed during both preparation attempts; retry the request",
  );
  expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
  const failure = new Error("fixture credentials unavailable");
  mocks.prepareStaticCatalog.mockReset().mockRejectedValue(failure);
  await expect(acquire(input)).rejects.toBe(failure);
  expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
});

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
  metadata.owners.providers = new Map(
    ["configured", "additional"].map((name) => [`${name}-provider`, [`${name}-plugin`]]),
  );
  await refresh(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    pluginMetadataSnapshot: metadata,
  });
  const published = expectDefined(await loadDispatch({ agentId: "default" }), "dispatch");
  const { agentDir, workspaceDir } = published;
  const input = { config, agentId: "default", agentDir, workspaceDir };
  const configured = expectDefined(readSnapshot(input), "configured snapshot");
  const acquireProvider = (provider: string, folder: string) =>
    acquire({
      ...input,
      workspaceDir: folder,
      runtimePluginSelections: [{ provider, modelId: "utility", runtime: "openclaw" }],
    });
  for (const folder of [input.workspaceDir, "/tmp/outside-folder"]) {
    await using covered = await acquireProvider("configured-provider", folder);
    expect(covered.snapshot).toBe(configured);
    expect(covered.pluginGeneration).toBe(published.pluginGeneration);
  }

  await using uncovered = await acquireProvider("additional-provider", "/tmp/outside-folder");
  expect(uncovered.snapshot).not.toBe(configured);
  expect(uncovered.pluginGeneration).not.toBe(published.pluginGeneration);
  expect(uncovered.snapshot.pluginRegistry).toBe(additionalRegistry);
  expect(readSnapshot(input)).toBe(configured);
  expect(await loadDispatch({ agentId: "default" })).toBe(published);
});

it("retains recent run owners for reuse and agent cleanup while evicting old selections", async () => {
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => createEmptyPluginRegistry());
  const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
  await refresh(config, { catalogMode: "static", gatewayLifecycle: true });
  const input = {
    config,
    agentId: "default",
    agentDir: fixture.state.agentDir("default"),
    workspaceDir: fixture.state.workspaceDir,
  };
  const acquireModel = async (modelId: string) => {
    await using lease = await acquire({
      ...input,
      loadRuntimePlugins: true,
      runtimePluginSelections: [{ provider: "openai", modelId, runtime: "codex" }],
    });
    return lease.snapshot;
  };

  const first = await acquireModel("run-model-0");
  const second = await acquireModel("run-model-1");
  {
    await using cleanup = await acquireCleanup(input.agentDir);
    for (const snapshot of [first, second]) {
      expect(cleanup.registries).toContain(snapshot.pluginRegistry);
    }
    await using unrelated = await acquireCleanup(fixture.state.agentDir("other"));
    expect(unrelated.registries).toEqual([]);
  }
  for (let index = 2; index < 8; index += 1) {
    await acquireModel(`run-model-${index}`);
  }
  const recent = await acquireModel("run-model-8");
  expect(await acquireModel("run-model-8")).toBe(recent);
  expect(await acquireModel("run-model-0")).not.toBe(first);
});
