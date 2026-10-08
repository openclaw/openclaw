import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  resolvePluginDiscoveryProvidersRuntime: () => [
    { id: native.id, label: "Fixture CLI", auth: [], prepareSyntheticAuth: native.probe },
    {
      id: "unrelated-cli",
      label: "Unrelated CLI",
      auth: [],
      prepareSyntheticAuth: native.unrelatedProbe,
    },
  ],
}));

const nativeLogin = {
  apiKey: "synthetic-native-presence",
  source: "Fixture CLI login",
  mode: "oauth",
  nativeAuth: { runtime: "fixture-cli", mode: "oauth" },
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  native.probe.mockReset().mockResolvedValue(undefined);
  native.unrelatedProbe.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(
  run: (state: {
    recheck: () => void;
    readAuth: () => PreparedModelCatalogAuth;
    publish: ReturnType<typeof vi.fn<(auth: PreparedModelCatalogAuth) => void>>;
    refreshAuth: ReturnType<typeof vi.fn>;
    retirement: AbortController;
  }) => Promise<void>,
  savedNativeProfile = false,
) {
  await using cache = createPluginCache();
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: native.id,
        providers: [native.id],
        cliBackends: [native.id],
        syntheticAuthRefs: [native.id],
      },
      { id: "unrelated-cli", providers: ["unrelated-cli"], syntheticAuthRefs: ["unrelated-cli"] },
      { id: "shared", providers: ["shared"] },
    ],
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
  await using _ = {
    [Symbol.asyncDispose]: retainPreparedPluginGeneration(pluginGeneration),
  };
  const config: OpenClawConfig = {};
  let auth: PreparedModelCatalogAuth = {
    authStore: {
      version: 1,
      profiles: {
        "shared:account": { type: "api_key", provider: "shared", key: "synthetic-shared-key" },
        ...(savedNativeProfile
          ? {
              "fixture-cli:saved": {
                type: "api_key" as const,
                provider: native.id,
                key: "synthetic-saved-key",
              },
            }
          : {}),
      },
    },
    credentials: {
      shared: { type: "api_key", key: "synthetic-shared-key" },
      ...(savedNativeProfile
        ? { [native.id]: { type: "api_key" as const, key: "synthetic-saved-key" } }
        : {}),
    },
    authModes: {
      shared: "api_key",
      ...(savedNativeProfile ? { [native.id]: "api_key" as const } : {}),
    },
    providerAuthLabels: new Map(),
  };
  const retirement = new AbortController();
  const refreshAuth = vi.fn(async () => {
    throw new Error("Native login checks must not load durable auth in the catalog worker");
  });
  const publish = vi.fn((next: PreparedModelCatalogAuth) => {
    auth = next;
  });
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
      agentFacts: { input: { config, agentDir: "/tmp/native-login-agent" }, env: {} },
      retirementSignal: retirement.signal,
    },
    [native.id, "unrelated-cli", "shared"],
    publish,
  );
  try {
    await run({ recheck, readAuth, publish, refreshAuth, retirement });
  } finally {
    retirement.abort();
  }
}

async function tick(recheck: () => void) {
  await vi.advanceTimersByTimeAsync(60_000);
  recheck();
  await vi.advanceTimersByTimeAsync(0);
}

it("publishes native login changes while unchanged reads reuse paired auth without worker discovery", async () => {
  await fixture(async ({ recheck, readAuth, publish, refreshAuth }) => {
    recheck();
    expect(native.probe).not.toHaveBeenCalled();
    await tick(recheck);
    expect(refreshAuth).not.toHaveBeenCalled();
    expect(native.probe).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();

    native.probe.mockResolvedValue(nativeLogin);
    await tick(recheck);
    expect(publish).toHaveBeenCalledOnce();
    expect(readAuth().authModes).toEqual({
      shared: "api_key",
      "fixture-cli": { source: "native", mode: "oauth" },
    });
    expect(readAuth().credentials?.[native.id]).toEqual({
      type: "api_key",
      key: "synthetic-native-presence",
      nativeAuth: { runtime: "fixture-cli", mode: "oauth" },
    });
    await tick(recheck);
    expect(publish).toHaveBeenCalledOnce();

    native.probe.mockResolvedValue(undefined);
    await tick(recheck);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(readAuth().authModes).toEqual({ shared: "api_key" });
    expect(readAuth().credentials).toEqual({
      shared: { type: "api_key", key: "synthetic-shared-key" },
    });
    expect(readAuth().authStore.profiles).toEqual({
      "shared:account": { type: "api_key", provider: "shared", key: "synthetic-shared-key" },
    });
    expect(native.unrelatedProbe).not.toHaveBeenCalled();
    expect(refreshAuth).not.toHaveBeenCalled();
  });
});

it("keeps saved profile credentials authoritative across native login and logout", async () => {
  await fixture(async ({ recheck, readAuth, publish, refreshAuth }) => {
    native.probe.mockResolvedValue(nativeLogin);
    await tick(recheck);
    native.probe.mockResolvedValue(undefined);
    await tick(recheck);
    expect(readAuth().credentials?.[native.id]).toEqual({
      type: "api_key",
      key: "synthetic-saved-key",
    });
    expect(readAuth().authModes[native.id]).toBe("api_key");
    expect(publish).not.toHaveBeenCalled();
    expect(refreshAuth).not.toHaveBeenCalled();
  }, true);
});

it("coalesces pending login checks and fences their result when the owner retires", async () => {
  await fixture(async ({ recheck, readAuth, publish, refreshAuth, retirement }) => {
    const started = createDeferredCore<AbortSignal>();
    const completed = createDeferredCore();
    native.probe.mockImplementation(async ({ signal }) => {
      if (!signal) {
        throw new Error("Native login checks must carry their owner's cancellation signal");
      }
      started.resolve(signal);
      await completed.promise;
      return nativeLogin;
    });
    try {
      await tick(recheck);
      expect(native.probe).toHaveBeenCalledOnce();
      const signal = await started.promise;
      await tick(recheck);
      expect(native.probe).toHaveBeenCalledOnce();
      retirement.abort();
      expect(signal.aborted).toBe(true);
      completed.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).not.toHaveBeenCalled();
      expect(readAuth().authModes).toEqual({ shared: "api_key" });
      expect(refreshAuth).not.toHaveBeenCalled();
    } finally {
      completed.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});
