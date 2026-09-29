// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "native-renewal" });
const { mocks } = fixture;

it("renews native observations without retaining harness-only host projections", async () => {
  const provider = "custom";
  const native = { provider, id: "native", name: "Native", nativeRuntime: "fixture-native" };
  const host = { provider, id: "host-only", name: "Host only" };
  const api = { provider, id: "api", name: "API" };
  const profile = {
    type: "oauth" as const,
    provider,
    accountId: "fixture-account",
    access: "before",
    refresh: "before-refresh",
    expires: 1_900_000_000_000,
  };
  const setProfile = (value: typeof profile) => {
    mocks.preparedAuthStore = { version: 1, profiles: { "custom:default": value } };
    const { provider: _provider, accountId: _accountId, ...credential } = value;
    mocks.authStorage.getAll.mockReturnValue({ custom: credential });
  };
  setProfile(profile);
  const load = vi.fn<() => Promise<ModelCatalogEntry[]>>(async () => [native, host]);
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "fixture-native",
      source: "fixture",
      harness: {
        id: "fixture-native",
        label: "Fixture",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog: load,
      },
    });
    return registry;
  });
  mocks.configuredAgentIds = ["default"];
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
    entries: [api],
    routeVariants: [api],
    providerOutcomes: [{ provider, status: "ready" }],
  }));
  const input = fixture.agentInput("default", { agents: { defaults: { model: "custom/api" } } });
  const options = { gatewayLifecycle: true, catalogMode: "static" as const };
  await refreshPreparedModelRuntimeSnapshots(input.config, options);
  const original = await prepareModelRuntimeSnapshot(input);
  const initial = await original.loadFullModelCatalog!();
  expect(initial.entries).toEqual(
    expect.arrayContaining([native, host, api].map((entry) => expect.objectContaining(entry))),
  );

  const started = createDeferred();
  const release = createDeferred<ModelCatalogEntry[]>();
  load.mockImplementation(async () => {
    started.resolve();
    return release.promise;
  });
  setProfile({ ...profile, access: "after", refresh: "after-refresh" });
  let discovery: Promise<unknown> | undefined;
  try {
    await refreshPreparedModelRuntimeSnapshots(input.config, options);
    const renewed = await prepareModelRuntimeSnapshot(input);
    discovery = renewed.loadFullModelCatalog!({ changedOnly: true });
    await started.promise;
    const pending = renewed.readFullModelCatalog!()!;
    expect(pending.entries).toEqual(
      expect.arrayContaining([native, api].map((entry) => expect.objectContaining(entry))),
    );
    expect(pending.entries).not.toContainEqual(expect.objectContaining(host));
    expect(pending.routeVariants).not.toContainEqual(expect.objectContaining(host));
    release.resolve([native, host]);
    await discovery;
    expect(renewed.readFullModelCatalog!()!.entries).toContainEqual(expect.objectContaining(host));
  } finally {
    release.resolve([native, host]);
    await discovery;
  }
});
