// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { DiscoverAuthStorageOptions } from "./agent-auth-discovery.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-discovery-lifetime" });
const { mocks } = fixture;

it("refreshes successor discovery auth after the preceding runtime registry retires", async () => {
  const { prepareAmbientAgentCredentialsForDiscovery } = await vi.importActual<
    typeof import("./agent-auth-discovery.js")
  >("./agent-auth-discovery.js");
  mocks.resolveAmbientCredentials.mockImplementation((options) =>
    prepareAmbientAgentCredentialsForDiscovery(
      // SAFETY: The harness forwards this typed production discovery call unchanged.
      options as Parameters<typeof prepareAmbientAgentCredentialsForDiscovery>[0],
    ),
  );
  mocks.discoverAuthStorage.mockImplementation((_dir, options) => ({
    // SAFETY: This adapter receives the production auth-storage discovery options.
    getAll: () => (options as DiscoverAuthStorageOptions).ambientCredentials,
    getOAuthProviders: () => [],
  }));
  const createRuntime = (version: string) => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "catalog-owner" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    registry.providers.push({
      pluginId: record.id,
      source: record.source,
      provider: { id: "runtime-provider", label: "Runtime provider", auth: [] },
    });
    // A discovery entry may expose auth absent from the runtime registration.
    const discovery = instance.wrap<ProviderPlugin>({
      id: "discovery-auth",
      label: "Discovery auth",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: `synthetic-${version}-not-real`,
        source: "fixture",
        mode: "api-key",
      }),
    });
    return { registry, instance, discovery };
  };
  const previous = createRuntime("previous");
  const successor = createRuntime("successor");
  const added = createPluginRecord({ id: "selected-owner" });
  successor.registry.plugins.push(added);
  const addedInstance = new PluginInstance(added.id, {
    record: added,
    registry: successor.registry,
  });
  successor.registry.providers.push({
    pluginId: added.id,
    source: added.source,
    provider: { id: "selected-provider", label: "Selected provider", auth: [] },
  });
  const discoveries = new Map([
    [previous.registry, previous.discovery],
    [successor.registry, successor.discovery],
  ]);
  mocks.prepareStaticCatalog.mockImplementation(async () => {
    const registry = getPluginRuntimeGenerationRegistry();
    const provider = registry && discoveries.get(registry);
    if (!provider) {
      throw new Error("Static discovery must run under its selected runtime registry");
    }
    return { entries: [], providers: [provider] };
  });
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
    params.selections?.some(
      (selection: { provider: string }) => selection.provider === "selected-provider",
    )
      ? successor.registry
      : previous.registry,
  );
  const input = {
    ...fixture.agentInput("default", {}),
    runtimePluginSelections: [{ provider: "runtime-provider", modelId: "model" }],
  };
  const expandedInput = {
    ...input,
    runtimePluginSelections: [
      ...input.runtimePluginSelections,
      { provider: "selected-provider", modelId: "model" },
    ],
  };
  const metadata = createPluginMetadataSnapshot({
    config: input.config,
    manifestRegistry: makeRegistry([
      { id: "catalog-owner", providers: ["runtime-provider", "discovery-auth"], channels: [] },
      { id: "selected-owner", providers: ["selected-provider"], channels: [] },
    ]),
  });
  const first = await prepareWorkspaceBuildGroup(
    [input],
    "static",
    {},
    undefined,
    undefined,
    metadata,
  );
  const releasePrevious = retainPreparedPluginGeneration(first.pluginGeneration);
  let releaseSuccessor: (() => Promise<void>) | undefined;
  try {
    expect(first.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
      key: "synthetic-previous-not-real",
    });
    const replacement = await prepareWorkspaceBuildGroup(
      [expandedInput],
      "static",
      {},
      undefined,
      first.pluginGeneration,
    );
    expect(replacement.pluginGeneration.pluginRegistry).toBe(successor.registry);
    expect(replacement.pluginGeneration.pluginRegistry).not.toBe(
      first.pluginGeneration.pluginRegistry,
    );
    releaseSuccessor = retainPreparedPluginGeneration(replacement.pluginGeneration);
    await releasePrevious();
    expect(previous.instance.lifecycle.signal.aborted).toBe(true);
    const refreshed = await prepareWorkspaceBuildGroup(
      [expandedInput],
      "static",
      {},
      undefined,
      replacement.pluginGeneration,
    );
    expect(refreshed.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
      key: "synthetic-successor-not-real",
    });
  } finally {
    await releasePrevious();
    await releaseSuccessor?.();
    await addedInstance.dispose();
  }
});
