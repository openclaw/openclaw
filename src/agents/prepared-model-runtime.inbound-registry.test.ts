// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  usePreparedModelRuntimeHarness,
  getPreparedModelRuntimeTestApi,
} from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyAgentConfig, pruneAgentConfig } from "../commands/agents.config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diffConfigPaths } from "../gateway/config-diff.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { createGatewayModelRuntimeReload } from "../gateway/server-reload-model-runtime-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { DiscoverAuthStorageOptions } from "./agent-auth-discovery.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import {
  scopePreparedModelRuntimeLease,
  withPreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import {
  acquireAgentRunPreparedModelRuntime,
  beginPreparedModelRuntimePluginDrain,
  ensureGatewayPreparedModelRuntimeReady,
  getPendingPreparedModelRuntimeReplacement,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  recoverPreparedModelRuntimeCatalogWorker,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
  rejectPendingPreparedModelRuntimeReplacement,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
type Dispatch = NonNullable<Awaited<ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>>;
type RunInput = Parameters<typeof acquireAgentRunPreparedModelRuntime>[0];
const staticMode = { catalogMode: "static" as const };

function acquire(input: RunInput, pluginGeneration?: Dispatch["pluginGeneration"]) {
  return acquireAgentRunPreparedModelRuntime(input, { ...staticMode, pluginGeneration });
}

function runInput(
  dispatch: Dispatch,
  runtimePluginSelections: RunInput["runtimePluginSelections"],
  config = dispatch.config,
  agentId = dispatch.agentId,
) {
  const { agentDir, workspaceDir } = dispatch;
  return { config, agentId, agentDir, workspaceDir, runtimePluginSelections };
}

function publishedDispatch(agentId = "default") {
  return loadPublishedGatewayReplyDispatchRuntime({ agentId });
}

function deferredGate() {
  const started = createDeferred();
  const finish = createDeferred();
  return {
    started: started.promise,
    wait: async () => {
      started.resolve();
      await finish.promise;
    },
    finish: () => finish.resolve(),
  };
}

function catalogGate() {
  const held = deferredGate();
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    await held.wait();
    return { entries: [] };
  });
  return held;
}

function prepareGroup(
  input: Parameters<typeof prepareWorkspaceBuildGroup>[0][number],
  previous?: Parameters<typeof prepareWorkspaceBuildGroup>[4],
  preparedMetadata?: Parameters<typeof prepareWorkspaceBuildGroup>[5],
) {
  return prepareWorkspaceBuildGroup([input], "static", {}, undefined, previous, preparedMetadata);
}

function publication(phase: "published" | "failed") {
  const ready = createDeferred();
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === phase) {
      ready.resolve();
    }
  });
  return async () => {
    await ready.promise;
    unregister();
  };
}

function provider(id: string, apiKey?: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    ...(apiKey
      ? { resolveSyntheticAuth: () => ({ apiKey, source: "fixture", mode: "api-key" as const }) }
      : {}),
  };
}

function registerProvider(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
  id: string,
  name: string,
) {
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  registry.providers.push({ pluginId: id, source: record.source, provider: provider(name) });
  return new PluginInstance(id, { record, registry });
}

function metadata(config: OpenClawConfig, plugins: Parameters<typeof makeRegistry>[0] = []) {
  return createPluginMetadataSnapshot({ config, manifestRegistry: makeRegistry(plugins) });
}

function publishGateway(
  config: OpenClawConfig = {},
  options: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[1] = {},
) {
  return refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    ...options,
  });
}

function authMutation(agentDir?: string) {
  mocks.mutationListener?.({ agentDir, affectsInheritedStores: agentDir === undefined });
}

async function useDiscoveryCredentials() {
  const { prepareAmbientAgentCredentialsForDiscovery } = await vi.importActual<
    typeof import("./agent-auth-discovery.js")
  >("./agent-auth-discovery.js");
  mocks.resolveAmbientCredentials.mockImplementation((options) =>
    prepareAmbientAgentCredentialsForDiscovery(
      options as Parameters<typeof prepareAmbientAgentCredentialsForDiscovery>[0],
    ),
  );
  mocks.discoverAuthStorage.mockImplementation((_dir, options) => ({
    getAll: () => (options as DiscoverAuthStorageOptions).ambientCredentials,
    getOAuthProviders: () => [],
  }));
}

describe("prepared reply dispatch runtime", () => {
  it("carries newly selected provider auth into a derived generation and its refresh", async () => {
    await useDiscoveryCredentials();
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "initial/model" } } };
    const selectedRegistry = createEmptyPluginRegistry();
    selectedRegistry.providers.push({
      pluginId: "selected-provider",
      source: "test",
      provider: provider("selected", "synthetic-provider-fixture"),
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
      params.selections?.some(
        (selection: { provider: string }) => selection.provider === "selected",
      )
        ? selectedRegistry
        : (params.reusableRegistry ?? createEmptyPluginRegistry()),
    );
    await publishGateway(config);
    const published = (await publishedDispatch())!;
    const input = runInput(
      published,
      [{ provider: "selected", modelId: "model", runtime: "openclaw" }],
      config,
      "default",
    );
    const lease = await acquire(input, published.pluginGeneration);
    expect(lease.snapshot.authModes.selected).toBe("api_key");
    await lease[Symbol.asyncDispose]();
    const publishedRefresh = publication("published");
    authMutation();
    await publishedRefresh();
    expect(getPreparedModelRuntimeSnapshot(input)?.authModes.selected).toBe("api_key");
  });

  it.each(["disabled", "error", "not-imported"] as const)(
    "preserves a selected provider's %s outcome when borrowing its parent lease",
    async (outcome) => {
      mocks.configuredAgentIds = ["default"];
      const config = {
        agents: { defaults: { model: "custom/model" } },
        plugins: {
          // A shared-capability fallback cannot excuse a missing selected model owner.
          slots: {
            memory: "none",
            ...(outcome === "not-imported" ? { contextEngine: "qwen" } : {}),
          },
          entries: { qwen: { enabled: outcome !== "disabled" } },
        },
      };
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(
        createPluginRecord({
          id: "qwen",
          origin: "bundled",
          status: outcome === "not-imported" ? "loaded" : outcome,
          enabled: outcome !== "disabled",
          imported: false,
          error: outcome === "error" ? "provider fixture failed to load" : undefined,
        }),
      );
      mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
        params.selections?.some(
          (selection: { provider: string }) => selection.provider === "bailian-token-plan",
        )
          ? registry
          : createEmptyPluginRegistry(),
      );
      const pluginMetadata = metadata(config, [
        { id: "qwen", origin: "bundled", channels: [], providers: ["bailian-token-plan"] },
      ]);
      await publishGateway(config, {
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: {
          ...pluginMetadata,
          owners: {
            ...pluginMetadata.owners,
            providers: new Map([["bailian-token-plan", ["qwen"]]]),
          },
        },
      });
      const published = (await publishedDispatch())!;
      const input = {
        ...runInput(
          published,
          [{ provider: "bailian-token-plan", modelId: "qwen3.7-max", runtime: "openclaw" }],
          config,
          "default",
        ),
        allowGatewaySubagentBinding: true,
      };
      const parent = await acquire(input, published.pluginGeneration);
      let active = true;
      try {
        await withPreparedModelRuntimePluginGenerationScope(
          parent.pluginGeneration,
          async () => {
            const borrowing = acquire(input, parent.pluginGeneration);
            if (outcome === "not-imported") {
              await expect(borrowing).rejects.toThrow("plugin generation was superseded");
              return;
            }
            const nested = await borrowing;
            expect(nested.snapshot).toBe(parent.snapshot);
            if (outcome === "error") {
              expect(nested.snapshot.pluginRegistry?.plugins[0]?.error).toBe(
                "provider fixture failed to load",
              );
            }
            await nested[Symbol.asyncDispose]();
          },
          () => (active ? parent.snapshot : undefined),
        );
      } finally {
        active = false;
        await parent[Symbol.asyncDispose]();
      }
    },
  );

  it.each(["add", "delete"] as const)(
    "keeps unchanged turns admitted across overlapping agent %s reloads",
    async (successor) => {
      const initialConfig: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { model: "openai/gpt-5.5" },
          entries: { free: {}, other: {} },
        },
      };
      mocks.configuredAgentIds = ["free", "other"];
      mocks.usePersistedAuthProfiles = true;
      const publishAuth = (config: OpenClawConfig) =>
        replaceRuntimeAuthProfileStoreSnapshots(
          Object.keys(config.agents!.entries!).map((id) => ({
            agentDir: fixture.state.agentDir(id),
            store: { version: 1, profiles: {} },
          })),
        );
      publishAuth(initialConfig);
      const firstConfig = applyAgentConfig(initialConfig, { agentId: "first" });
      const latestConfig =
        successor === "add"
          ? applyAgentConfig(firstConfig, { agentId: "second" })
          : pruneAgentConfig(firstConfig, "other").config;
      const reload = createGatewayModelRuntimeReload();
      const prepare = (previous: OpenClawConfig, next: OpenClawConfig) =>
        reload.prepare(buildGatewayReloadPlan(diffConfigPaths(previous, next)), previous, next);
      const options = {
        gatewayLifecycle: true,
        catalogMode: "static" as const,
        allowGatewaySubagentBinding: true,
        joinSupersedingPublication: true,
      };
      await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
      await using resources = new AsyncDisposableStack();
      let captured: ReturnType<typeof scopePreparedModelRuntimeLease> | undefined;
      const dispatch = (await loadPublishedGatewayReplyDispatchRuntime({
        agentId: "free",
        onRuntimeLease: (lease) => {
          captured = resources.use(scopePreparedModelRuntimeLease(lease));
        },
      }))!;
      const gate = catalogGate();
      mocks.configuredAgentIds = ["free", "other", "first"];
      const firstScope = prepare(initialConfig, firstConfig);
      publishAuth(firstConfig);
      const first = refreshPreparedModelRuntimeSnapshots(firstConfig, {
        ...options,
        ...firstScope.scope,
      });
      let second: Promise<void> | undefined;
      try {
        await gate.started;
        firstScope.defer();
        mocks.configuredAgentIds = Object.keys(latestConfig.agents!.entries!);
        const secondScope = prepare(firstConfig, latestConfig);
        publishAuth(latestConfig);
        markPreparedModelRuntimeSnapshotsStale(undefined, {
          waitForReplacement: true,
          ...secondScope.scope,
        });
        second = refreshPreparedModelRuntimeSnapshots(latestConfig, {
          ...options,
          ...secondScope.scope,
        });
        gate.finish();
        await Promise.all([first, second]);

        const admissionInput = {
          ...runInput(dispatch, [{ provider: "openai", modelId: "gpt-5.5" }]),
          allowGatewaySubagentBinding: true,
        };
        await using pendingTurn = await acquireAgentRunPreparedModelRuntime(admissionInput, {
          pluginGeneration: dispatch.pluginGeneration,
        });
        expect(pendingTurn.pluginGeneration).toBe(dispatch.pluginGeneration);
        await captured!.run(async () => {
          await using resumed = await acquireAgentRunPreparedModelRuntime(admissionInput, {
            pluginGeneration: dispatch.pluginGeneration,
          });
          expect(resumed.pluginGeneration).toBe(dispatch.pluginGeneration);
        });
        const latest = (await publishedDispatch("free"))!;
        expect(latest.pluginGeneration).toBe(dispatch.pluginGeneration);
        expect(latest.config).toBe(latestConfig);
        await using admitted = await acquireAgentRunPreparedModelRuntime({
          ...fixture.agentInput("free", latestConfig),
          workspaceDir: latest.workspaceDir,
          allowGatewaySubagentBinding: true,
        });
        expect(admitted.snapshot.config).toBe(latestConfig);
        for (const agentId of mocks.configuredAgentIds.filter((id) => id !== "free")) {
          expect(await publishedDispatch(agentId)).toMatchObject({
            agentId,
            config: latestConfig,
          });
        }
      } finally {
        gate.finish();
        await Promise.allSettled([first, second]);
      }
    },
  );

  it("keeps unaffected dispatch and run admission available when a scoped replacement fails", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    const input = fixture.agentInput("default", {});
    await publishGateway(input.config);
    const original = await publishedDispatch();
    const gate = markPreparedModelRuntimeSnapshotsStale("worker agent reload", {
      waitForReplacement: true,
      agentIds: new Set(["worker"]),
    });
    const leases: PreparedModelRuntimeLease[] = [];
    const reading = Promise.all([
      loadPublishedGatewayReplyDispatchRuntime({
        agentId: "default",
        onRuntimeLease: (lease) => leases.push(lease),
      }),
      prepareModelRuntimeSnapshot(input),
      acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static" }).then((lease) => {
        leases.push(lease);
        return lease;
      }),
    ]);
    const observed = reading.catch((error: unknown) => error);
    try {
      // Join the same healthy demand preflight while the other agent's reload remains pending.
      await ensureGatewayPreparedModelRuntimeReady({ agentId: "default" });
      rejectPendingPreparedModelRuntimeReplacement(gate, new Error("worker database is closing"));
      const [dispatch, snapshot, lease] = await reading;
      expect(dispatch).toMatchObject({
        agentId: "default",
        pluginGeneration: original?.pluginGeneration,
      });
      expect(snapshot.isCurrent()).toBe(true);
      expect(lease.snapshot.isCurrent()).toBe(true);
      await expect(publishedDispatch()).resolves.toBe(original);
      await expect(publishedDispatch("worker")).rejects.toThrow("was not published for worker");
    } finally {
      rejectPendingPreparedModelRuntimeReplacement(gate, new Error("test cleanup"));
      await observed;
      await Promise.all(leases.map((lease) => lease[Symbol.asyncDispose]()));
    }
  });

  it("recovers a rejected auth refresh projection without affecting siblings", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    await publishGateway();
    const defaultRuntime = await publishedDispatch();
    const refreshFailed = publication("failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw new Error("auth refresh rejected");
    });

    authMutation(fixture.state.agentDir("worker"));
    await refreshFailed();

    await expect(publishedDispatch("worker")).resolves.toMatchObject({ agentId: "worker" });
    const retained = await publishedDispatch();
    expect(retained?.pluginGeneration).toBe(defaultRuntime?.pluginGeneration);
  });

  it("aborts run admission without retaining an owner after auth publication", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const input = {
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      config,
      workspaceDir: "/tmp/dynamic-workspace",
    };
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const testApi = getPreparedModelRuntimeTestApi();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    const held = deferredGate();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      await held.wait();
      return {};
    });

    let admission: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
    try {
      authMutation(input.agentDir);
      await held.started;
      const abort = new AbortController();
      admission = acquireAgentRunPreparedModelRuntime(input, { abortSignal: abort.signal });
      const observed = admission.then(
        () => "resolved",
        () => "rejected",
      );
      await expect(Promise.race([observed, Promise.resolve("pending")])).resolves.toBe("pending");
      abort.abort(new Error("request cancelled"));
      await expect(admission).rejects.toMatchObject({ name: "AbortError" });
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

      held.finish();
      await publishedDispatch();
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
      const lease = await acquireAgentRunPreparedModelRuntime(input);
      expect(lease.snapshot).toMatchObject({
        agentId: "default",
        agentDir: input.agentDir,
        workspaceDir: "/tmp/unused-workspace",
      });
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
      await lease[Symbol.asyncDispose]();
    } finally {
      held.finish();
      await Promise.allSettled([
        admission?.then((lease) => lease[Symbol.asyncDispose]()),
        publishedDispatch(),
      ]);
    }
  });
});

it("refreshes successor discovery auth after the preceding runtime registry retires", async () => {
  await useDiscoveryCredentials();
  const createRuntime = (version: string) => {
    const registry = createEmptyPluginRegistry();
    const instance = registerProvider(registry, "catalog-owner", "runtime-provider");
    // A discovery entry may expose auth absent from the runtime registration.
    const discovery = instance.wrap(provider("discovery-auth", `synthetic-${version}-not-real`));
    return { registry, instance, discovery };
  };
  const previous = createRuntime("previous");
  const successor = createRuntime("successor");
  const addedInstance = registerProvider(successor.registry, "selected-owner", "selected-provider");
  const discoveries = new Map([
    [previous.registry, previous.discovery],
    [successor.registry, successor.discovery],
  ]);
  mocks.prepareStaticCatalog.mockImplementation(async () => {
    const registry = getPluginRuntimeGenerationRegistry();
    const discovery = registry && discoveries.get(registry);
    if (!discovery) {
      throw new Error("Static discovery must run under its selected runtime registry");
    }
    return { entries: [], providers: [discovery] };
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
  const pluginMetadata = metadata(input.config, [
    { id: "catalog-owner", providers: ["runtime-provider", "discovery-auth"], channels: [] },
    { id: "selected-owner", providers: ["selected-provider"], channels: [] },
  ]);
  const first = await prepareGroup(input, undefined, pluginMetadata);
  const releasePrevious = retainPreparedPluginGeneration(first.pluginGeneration);
  let releaseSuccessor: (() => Promise<void>) | undefined;
  try {
    expect(first.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
      key: "synthetic-previous-not-real",
    });
    const replacement = await prepareGroup(expandedInput, first.pluginGeneration);
    expect(replacement.pluginGeneration.pluginRegistry).toBe(successor.registry);
    releaseSuccessor = retainPreparedPluginGeneration(replacement.pluginGeneration);
    await releasePrevious();
    expect(previous.instance.lifecycle.signal.aborted).toBe(true);
    const refreshed = await prepareGroup(expandedInput, replacement.pluginGeneration);
    expect(refreshed.agentFacts[0]?.credentials["discovery-auth"]).toMatchObject({
      key: "synthetic-successor-not-real",
    });
  } finally {
    await releasePrevious();
    await releaseSuccessor?.();
    await addedInstance.dispose();
  }
});

describe("catalog-worker replacement demand", () => {
  const dispatch = (demand: "interactive" | "scheduled" = "interactive") =>
    loadPublishedGatewayReplyDispatchRuntime({ agentId: "default", demand });
  async function failReplacement(snapshot?: PreparedModelRuntimeSnapshot, agentIds = ["default"]) {
    const input = fixture.agentInput("default", snapshot?.config ?? {});
    if (!snapshot) {
      mocks.configuredAgentIds = agentIds;
      await publishGateway(input.config, { allowGatewaySubagentBinding: true });
    }
    const prepared = snapshot ?? (await prepareModelRuntimeSnapshot(input));
    const failure = new Error("catalog replacement preparation failed");
    mocks.resolveAmbientCredentials.mockRejectedValueOnce(failure);
    await expect(recoverPreparedModelRuntimeCatalogWorker([prepared])).rejects.toBe(failure);
    return { input, failure };
  }

  it.each(["successful", "failed"] as const)(
    "shares a %s demand replacement without activating pure snapshot reads",
    async (outcome) => {
      const { input, failure } = await failReplacement();
      mocks.resolveAmbientCredentials.mockClear();
      await expect(prepareModelRuntimeSnapshot(input)).rejects.toBe(failure);
      expect(mocks.resolveAmbientCredentials).not.toHaveBeenCalled();
      const held = deferredGate();
      mocks.resolveAmbientCredentials.mockImplementationOnce(async () => {
        await held.wait();
        if (outcome === "failed") {
          throw failure;
        }
        return {};
      });
      const foreground = dispatch();
      let background: ReturnType<typeof dispatch> | undefined;
      try {
        expect(await Promise.race([held.started, foreground])).toBeUndefined();
        background = dispatch("scheduled");
        const shared = Promise.all([foreground, background]);
        held.finish();
        if (outcome === "failed") {
          await shared.catch(() => undefined);
          for (const request of [foreground, background]) {
            await expect(request).rejects.toMatchObject({
              reason: "attempt-failed",
              cause: failure,
            });
          }
          await expect(dispatch("scheduled")).rejects.toThrow("was not published");
          expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
          return;
        }
        const [recovered, joined] = await shared;
        expect(recovered).toMatchObject({ agentId: "default", config: input.config });
        expect(joined).toBe(recovered);
        expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
      } finally {
        held.finish();
        await Promise.allSettled([foreground, background]);
      }
    },
  );

  it("limits scheduled checks to one per failure, retaining foreground recovery after cooldown", async () => {
    const { input } = await failReplacement();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repeatedFailure = new Error("catalog replacement still fails");
    mocks.resolveAmbientCredentials.mockClear().mockImplementation(() => {
      throw repeatedFailure;
    });
    try {
      await expect(dispatch("scheduled")).rejects.toMatchObject({ cause: repeatedFailure });
      await expect(dispatch()).rejects.toThrow("was not published");
      clock.mockReturnValue(20_000);
      await expect(dispatch("scheduled")).rejects.toThrow("was not published");
      expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
      await expect(dispatch()).rejects.toMatchObject({ cause: repeatedFailure });
      clock.mockReturnValue(30_000);
      await expect(dispatch("scheduled")).rejects.toThrow("was not published");
      expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(2);
      mocks.resolveAmbientCredentials.mockReturnValue({});
      expect(await dispatch()).toMatchObject({ agentId: "default" });
      await failReplacement(await prepareModelRuntimeSnapshot(input));
      expect(await dispatch("scheduled")).toMatchObject({ agentId: "default" });
      expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(5);
    } finally {
      clock.mockRestore();
    }
  });
  it("does not spend the scheduled check while waiting for an unrelated failed replacement", async () => {
    await failReplacement(undefined, ["default", "other"]);
    const drain = beginPreparedModelRuntimePluginDrain();
    const waiting = dispatch("scheduled");
    const prematureReplacement = getPendingPreparedModelRuntimeReplacement();
    const gate = markPreparedModelRuntimeSnapshotsStale("other agent reload", {
      waitForReplacement: true,
      agentIds: new Set(["other"]),
    });
    const unrelatedFailure = new Error("other agent reload failed");
    const rejected = expect(waiting).rejects.toBe(unrelatedFailure);
    drain.release();
    await Promise.resolve();
    rejectPendingPreparedModelRuntimeReplacement(gate, unrelatedFailure);
    await rejected;
    expect(prematureReplacement).toBeUndefined();
    mocks.resolveAmbientCredentials.mockClear();
    expect(await dispatch("scheduled")).toMatchObject({ agentId: "default" });
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalled();
  });
});
