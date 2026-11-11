import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindPluginMetadataSnapshotCache, createPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PreparedModelCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  createNativeLoginRecheck,
  createPreparedAccountCatalogAccess,
} from "./prepared-model-runtime.catalog-auth.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

const native = vi.hoisted(() => ({
  id: "fixture-cli",
  probe: vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(),
  unrelatedProbe: vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(),
}));

// mock-isolation: Supply discovery descriptors without loading installed plugins or CLI processes.
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () =>
    [native.id, "unrelated-cli"].map((id) => ({
      id,
      label: id,
      auth: [],
      prepareSyntheticAuth: id === native.id ? native.probe : native.unrelatedProbe,
    })),
}));

const nativeLogin = {
  apiKey: "synthetic-native-presence",
  source: "Fixture CLI login",
  mode: "oauth",
  nativeAuth: { runtime: "fixture-cli", mode: "oauth" },
} as const;
const sharedCredential = { type: "api_key", key: "synthetic-shared-key" } as const;
const savedCredential = { type: "api_key", key: "synthetic-saved-key" } as const;
const sharedProfiles = { "shared:account": { ...sharedCredential, provider: "shared" } };
const refreshAuth = vi.fn(async () => {
  throw new Error("Native login checks must not load durable auth in the catalog worker");
});

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  native.probe.mockReset().mockResolvedValue(undefined);
  native.unrelatedProbe.mockReset();
  refreshAuth.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(refreshAuth).not.toHaveBeenCalled();
  expect(native.unrelatedProbe).not.toHaveBeenCalled();
});

function fixture(resources: AsyncDisposableStack, savedNativeProfile = false) {
  const cache = resources.use(createPluginCache());
  const retirement = new AbortController();
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [native.id, "unrelated-cli", "shared"].map((id) => ({
      id,
      providers: [id],
      cliBackends: id === native.id ? [id] : [],
    })),
  });
  metadata.index.plugins[0]!.syntheticAuthRefs = [native.id];
  metadata.index.plugins[1]!.syntheticAuthRefs = ["unrelated-cli"];
  bindPluginMetadataSnapshotCache(metadata, cache);
  const pluginGeneration: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: metadata,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  resources.defer(retainPreparedPluginGeneration(pluginGeneration));
  resources.defer(() => retirement.abort());
  const credentials: Record<string, { type: "api_key"; key: string }> = {
    shared: sharedCredential,
  };
  const profiles: PreparedModelCatalogAuth["authStore"]["profiles"] = { ...sharedProfiles };
  if (savedNativeProfile) {
    credentials[native.id] = savedCredential;
    profiles[`${native.id}:saved`] = { ...savedCredential, provider: native.id };
  }
  let auth: PreparedModelCatalogAuth = {
    authStore: { version: 1, profiles },
    credentials,
    authModes: Object.fromEntries(Object.keys(credentials).map((id) => [id, "api_key" as const])),
    providerAuthLabels: new Map(),
  };
  const publish = vi.fn((next: PreparedModelCatalogAuth) => (auth = next));
  const readAuth = () => auth;
  const recheck = createNativeLoginRecheck(
    {
      pluginGeneration,
      accountCatalog: createPreparedAccountCatalogAccess(() => !retirement.signal.aborted),
      normalizeProvider: (provider) => provider,
      assertCurrent: () => retirement.signal.throwIfAborted(),
      readAuth,
      refreshAuth,
    },
    {
      agentFacts: { input: { config: {}, agentDir: "/tmp/native-login-agent" }, env: {} },
      retirementSignal: retirement.signal,
    },
    [native.id, "unrelated-cli", "shared"],
    publish,
  );
  return { recheck, readAuth, publish, retirement };
}

async function tick(recheck: () => void | Promise<void>) {
  await vi.advanceTimersByTimeAsync(60_000);
  void recheck();
  await vi.advanceTimersByTimeAsync(0);
}

it("publishes native login recovery on forced admission recheck without waiting for the TTL", async () => {
  await using resources = new AsyncDisposableStack();
  const { recheck, readAuth, publish } = fixture(resources);
  void recheck();
  expect(native.probe).not.toHaveBeenCalled();
  await tick(recheck);
  expect(publish).not.toHaveBeenCalled();

  native.probe.mockResolvedValue(nativeLogin);
  await recheck({ force: true });
  expect(readAuth().authModes).toEqual({
    shared: "api_key",
    "fixture-cli": { source: "native", mode: "oauth" },
  });
  expect(readAuth().credentials?.[native.id]).toEqual({
    type: "api_key",
    key: nativeLogin.apiKey,
    nativeAuth: nativeLogin.nativeAuth,
  });
  await tick(recheck);
  expect(publish).toHaveBeenCalledOnce();

  native.probe.mockResolvedValue(undefined);
  await tick(recheck);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(readAuth().authModes).toEqual({ shared: "api_key" });
  expect(readAuth().credentials).toEqual({ shared: sharedCredential });
  expect(readAuth().authStore.profiles).toEqual(sharedProfiles);
});

it("keeps saved profile credentials authoritative across native login and logout", async () => {
  await using resources = new AsyncDisposableStack();
  const { recheck, readAuth, publish } = fixture(resources, true);
  native.probe.mockResolvedValue(nativeLogin);
  await tick(recheck);
  native.probe.mockResolvedValue(undefined);
  await tick(recheck);
  expect(readAuth().credentials?.[native.id]).toEqual(savedCredential);
  expect(readAuth().authModes[native.id]).toBe("api_key");
  expect(publish).not.toHaveBeenCalled();
});

it("coalesces pending login checks and fences their result when the owner retires", async () => {
  await using resources = new AsyncDisposableStack();
  const { recheck, readAuth, publish, retirement } = fixture(resources);
  const completed = createDeferredCore<typeof nativeLogin>();
  native.probe.mockImplementation(() => completed.promise);
  resources.defer(async () => {
    completed.resolve(nativeLogin);
    await vi.advanceTimersByTimeAsync(0);
  });
  await tick(recheck);
  expect(native.probe).toHaveBeenCalledOnce();
  const signal = native.probe.mock.calls[0]![0].signal;
  await tick(recheck);
  expect(native.probe).toHaveBeenCalledOnce();
  retirement.abort();
  expect(signal?.aborted).toBe(true);
  completed.resolve(nativeLogin);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).not.toHaveBeenCalled();
  expect(readAuth().authModes).toEqual({ shared: "api_key" });
});
