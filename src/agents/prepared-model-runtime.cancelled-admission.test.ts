// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { acquirePreparedModelRuntimeLeaseFromOwners } from "./prepared-model-runtime-lease.js";
import * as runtimeBuild from "./prepared-model-runtime.build.js";
import {
  acquireAgentRunPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  registerPreparedModelRuntimePublicationListener,
  acquireReadOnlyPreparedModelRuntime,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeInput,
} from "./prepared-model-runtime.js";
import { createPreparedModelRuntimeReplacement } from "./prepared-model-runtime.lifecycle.js";
import * as owners from "./prepared-model-runtime.owner.js";
import { PreparedModelRuntimeOwnerRetention } from "./prepared-model-runtime.retention.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "prepared-runtime-cancelled-admission" },
  async () => {
    for (const release of pendingBuildReleases) {
      release.resolve();
    }
    await Promise.all(
      buildBatchSpy.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value.completion] : [],
      ),
    );
    buildBatchSpy.mockRestore();
  },
);
const { mocks } = fixture;
const testApi = getPreparedModelRuntimeTestApi();
const configuredInput = () => fixture.agentInput("default", {});

let buildBatchSpy: Mock<typeof runtimeBuild.startSerializedSnapshotBuildBatch>;
let pendingBuildReleases: Array<{ resolve: () => void }>;

function prepareColdBuildGate() {
  const started = createDeferred();
  const release = createDeferred();
  pendingBuildReleases.push(release);
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return { entries: [] };
  });
  return { started, release };
}

function dynamicInput(label: string): PreparedModelRuntimeInput {
  return {
    agentId: "default",
    agentDir: fixture.state.agentDir("default"),
    config: {},
    workspaceDir: `/tmp/${label}`,
  };
}

describe("prepared model runtime cancelled admission ownership", () => {
  beforeEach(() => {
    pendingBuildReleases = [];
    buildBatchSpy = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch");
  });

  it("retires a sole cold ephemeral owner before shared discovery finishes", async () => {
    const input = dynamicInput("cancelled-ephemeral");
    const build = prepareColdBuildGate();
    const abort = new AbortController();
    const admission = acquireReadOnlyPreparedModelRuntime(input, {
      abortSignal: abort.signal,
      catalogMode: "static",
    });

    await build.started.promise;
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    abort.abort(new Error("request cancelled"));
    await expect(admission).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);

    build.release.resolve();
  });

  it("retires a coalesced cold owner only after the final admission cancels", async () => {
    const input = dynamicInput("coalesced-cancellations");
    const build = prepareColdBuildGate();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: firstAbort.signal,
    });

    await build.started.promise;
    const second = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: secondAbort.signal,
    });
    const secondObserved = second.then(
      () => "resolved",
      () => "rejected",
    );
    await expect(Promise.race([secondObserved, Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );

    firstAbort.abort(new Error("first request cancelled"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    secondAbort.abort(new Error("second request cancelled"));
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);

    build.release.resolve();
  });

  it("keeps one shared build for a survivor after its peer cancels", async () => {
    const input = dynamicInput("cancelled-peer-survivor");
    const build = prepareColdBuildGate();
    const cancelledAbort = new AbortController();
    const cancelled = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: cancelledAbort.signal,
    });

    await build.started.promise;
    const survivor = acquireAgentRunPreparedModelRuntime(input);

    cancelledAbort.abort(new Error("peer request cancelled"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    build.release.resolve();
    const lease = await survivor;
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    await lease[Symbol.asyncDispose]();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
  });

  it("does not let an abandoned publication satisfy or delete its same-key replacement", async () => {
    const input = dynamicInput("same-key-replacement");
    const firstBuild = prepareColdBuildGate();
    const firstAbort = new AbortController();
    const abandoned = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: firstAbort.signal,
    });

    await firstBuild.started.promise;
    firstAbort.abort(new Error("first request cancelled"));
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);

    const secondBuild = prepareColdBuildGate();
    const replacement = acquireAgentRunPreparedModelRuntime(input);
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    firstBuild.release.resolve();
    await secondBuild.started.promise;
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    secondBuild.release.resolve();
    const lease = await replacement;
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    await lease[Symbol.asyncDispose]();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
  });

  it("skips workspace preparation for a cancelled queued replacement", async () => {
    const input = dynamicInput("queued-cancelled-replacement");
    const firstBuild = prepareColdBuildGate();
    const firstAbort = new AbortController();
    const first = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: firstAbort.signal,
    });

    await firstBuild.started.promise;
    firstAbort.abort(new Error("first request cancelled"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const queuedAbort = new AbortController();
    const queued = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: queuedAbort.signal,
    });
    queuedAbort.abort(new Error("queued request cancelled"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    const survivor = acquireAgentRunPreparedModelRuntime(input);
    firstBuild.release.resolve();

    const lease = await survivor;
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);

    await lease[Symbol.asyncDispose]();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
  });

  it("preserves the configured baseline and clears a later retained lease on refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    mocks.prepareStaticCatalog.mockClear();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    const input = {
      ...dynamicInput("gateway-retained-owner"),
      config,
    };
    const cancelledBuild = prepareColdBuildGate();
    const abort = new AbortController();
    const cancelled = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: abort.signal,
    });

    await cancelledBuild.started.promise;
    abort.abort(new Error("gateway request cancelled"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    cancelledBuild.release.resolve();
    const retainedLease = await acquireAgentRunPreparedModelRuntime(input);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(2);

    await retainedLease[Symbol.asyncDispose]();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(2);

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
  });
  it("retires model publication before auth snapshots are cleared during restart", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const prepared = getPreparedModelRuntimeSnapshot(configuredInput());
    expect(prepared).toBeDefined();
    await drainGlobalSingletonLifecycleState("restart");
    const builds = mocks.ensureOpenClawModelsJson.mock.calls.length;
    mocks.mutationListener?.({ affectsInheritedStores: true, profileSetChanged: true });
    await nextTurn();
    expect(getPreparedModelRuntimeSnapshot(configuredInput())).toBeUndefined();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(builds);
    expect(prepared?.isCurrent()).toBe(false);
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toBeUndefined();
  });

  it.each(["auth", "config"] as const)(
    "joins the raw %s publication before completing process close",
    async (source) => {
      mocks.configuredAgentIds = ["default"];
      await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
      const entered = createDeferred();
      const release = createDeferred();
      const published = vi.fn();
      const unregister = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "published") {
          published();
        }
      });
      mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
        entered.resolve();
        await release.promise;
        return { agentDir: String(agentDir), wrote: false };
      });
      let refresh: Promise<void> | undefined;
      if (source === "auth") {
        mocks.mutationListener?.({ affectsInheritedStores: true });
      } else {
        refresh = refreshPreparedModelRuntimeSnapshots({});
        void refresh.catch(() => {});
      }
      await entered.promise;
      const reader = prepareModelRuntimeSnapshot(configuredInput());
      void reader.catch(() => {});
      let closed = false;
      const closing = drainGlobalSingletonLifecycleState("close").then(() => {
        closed = true;
      });
      try {
        await nextTurn();
        expect(closed).toBe(false);
        release.resolve();
        await closing;
        await expect(reader).rejects.toThrow(/closed|superseded/);
        expect(getPreparedModelRuntimeSnapshot(configuredInput())).toBeUndefined();
        expect(published).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([refresh, reader, closing]);
        unregister();
      }
    },
  );

  it("preserves immutable leased data while close drains and allows a fresh standalone activation", async ({
    signal,
  }) => {
    const input = { config: {}, agentDir: fixture.state.agentDir("direct") };
    const options = { retainIdleRunOwner: true, abortSignal: signal };
    const previous = await acquireAgentRunPreparedModelRuntime(input, options);
    let closed = false;
    const closing = drainGlobalSingletonLifecycleState("close").then(() => {
      closed = true;
    });
    try {
      await nextTurn(undefined, { signal });
      expect(closed).toBe(false);
      expect(previous.snapshot.isCurrent()).toBe(false);
      expect(previous.snapshot.createStores()).toBeDefined();
      await previous[Symbol.asyncDispose]();
      await closing;
      const next = await acquireAgentRunPreparedModelRuntime(input, options);
      try {
        expect(next.snapshot).not.toBe(previous.snapshot);
        await previous[Symbol.asyncDispose]();
        expect(getPreparedModelRuntimeSnapshot(input)).toBe(next.snapshot);
        expect(next.snapshot.isCurrent()).toBe(true);
      } finally {
        await next[Symbol.asyncDispose]();
      }
    } finally {
      await previous[Symbol.asyncDispose]();
      await closing;
    }
  });

  it("does not revive a queued standalone activation after its process lifetime closes", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const input = { config: {}, agentDir: fixture.state.agentDir("queued") };
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
      entered.resolve();
      await release.promise;
      return { agentDir: String(agentDir), wrote: false };
    });
    const first = activateStandalonePreparedModelRuntime(input);
    void first.catch(() => {});
    await entered.promise;
    const second = activateStandalonePreparedModelRuntime(input);
    void second.catch(() => {});
    const closing = drainGlobalSingletonLifecycleState("close");
    try {
      release.resolve();
      await closing;
      await expect(first).rejects.toThrow(/closed|superseded/);
      await expect(second).rejects.toThrow(/closed|superseded/);
      expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second, closing]);
    }
  });
});

describe("prepared model runtime automatic selections", () => {
  it("acquires nested auto leases without switching to the default agent's runtime policy", async () => {
    fixture.mocks.configuredAgentIds = ["default", "worker"];
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { model: "xai/grok-4.6", systemAgent: { agentId: "default" } },
        entries: {
          default: { models: { "xai/grok-4.6": { agentRuntime: { id: "other-harness" } } } },
          worker: {},
        },
      },
    };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const dispatch = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    expect(dispatch).toBeDefined();
    const input = {
      ...fixture.agentInput("worker", config),
      workspaceDir: dispatch!.workspaceDir,
      runtimePluginSelections: [{ provider: "xai", modelId: "grok-4.6", runtime: "auto" }],
    };
    const options = { pluginGeneration: dispatch!.pluginGeneration };
    await using outer = await acquireAgentRunPreparedModelRuntime(input, options);
    expect(fixture.mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.at(-1)?.[0]).toMatchObject(
      {
        selections: [{ provider: "xai", modelId: "grok-4.6", runtime: "openclaw" }],
      },
    );
    const resolveConfiguredOwner = owners.resolveConfiguredOwner;
    let iterations = 0;
    // Bound the pre-fix microtask livelock; a timer cannot interrupt it.
    const guard = vi.spyOn(owners, "resolveConfiguredOwner").mockImplementation((...args) => {
      if (++iterations > 8) {
        throw new Error("lease admission repeated without completing");
      }
      return resolveConfiguredOwner(...args);
    });
    try {
      await using nested = await acquireAgentRunPreparedModelRuntime(
        {
          ...input,
          runtimePluginSelections: [{ ...input.runtimePluginSelections[0]!, agentId: "worker" }],
        },
        options,
      );
      expect(nested.snapshot).toBe(outer.snapshot);
      expect(nested.snapshot.isCurrent()).toBe(true);
    } finally {
      guard.mockRestore();
    }
  });

  it("rejects a settled replacement that never publishes instead of spinning", async () => {
    const replacement = createPreparedModelRuntimeReplacement();
    replacement.resolve();
    let iterations = 0;
    await expect(
      acquirePreparedModelRuntimeLeaseFromOwners(fixture.agentInput("worker", {}), "run", {
        captureLifetime: () => () => {
          if (++iterations > 16) {
            throw new Error("test iteration guard reached");
          }
        },
        owners: new Map(),
        agentBuildCompletions: new Map(),
        retainedDirectRunOwners: new PreparedModelRuntimeOwnerRetention(1),
        retainedGatewayRunOwners: new PreparedModelRuntimeOwnerRetention(8),
        getBuildTimeoutMs: () => 120_000,
        getGatewayLifecycleActive: () => true,
        getPendingReplacement: () => replacement,
      }),
    ).rejects.toThrow("lease admission made no publication progress");
  });
});
