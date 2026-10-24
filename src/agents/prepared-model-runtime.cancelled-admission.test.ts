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
  acquireAgentRunPreparedModelRuntime as acquireRun,
  activateStandalonePreparedModelRuntime as activate,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime as loadPublishedDispatch,
  prepareModelRuntimeSnapshot as prepare,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots as refresh,
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

function cancellableRun(input: PreparedModelRuntimeInput) {
  const controller = new AbortController();
  const pending = acquireRun(input, { abortSignal: controller.signal });
  return {
    pending,
    cancel(reason: string) {
      controller.abort(new Error(reason));
      return expect(pending).rejects.toMatchObject({ name: "AbortError" });
    },
  };
}

function holdModelBuild() {
  const entered = createDeferred();
  const release = createDeferred();
  pendingBuildReleases.push(release);
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, _agentDir) => {
    entered.resolve();
    await release.promise;
    return {};
  });
  return { entered, release };
}

function closeProcess() {
  const closing = { done: false, promise: Promise.resolve() };
  closing.promise = drainGlobalSingletonLifecycleState("close").then(() => {
    closing.done = true;
  });
  return closing;
}

function observe<T>(pending: Promise<T>) {
  void pending.catch(() => {});
  return pending;
}

describe("prepared model runtime cancelled admission ownership", () => {
  beforeEach(() => {
    pendingBuildReleases = [];
    buildBatchSpy = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch");
  });

  it.each([
    ["retains a shared cold owner until its final admission cancels", "cancel"],
    ["retains a shared cold owner until its final admission finishes", "finish"],
    ["does not let an abandoned publication satisfy or delete its same-key replacement", "replace"],
    ["skips workspace preparation for a cancelled queued replacement", "skip"],
  ] as const)("%s", async (_name, outcome) => {
    const input = dynamicInput("coalesced-admissions");
    const build = prepareColdBuildGate();
    const first = cancellableRun(input);
    await build.started.promise;
    const shared = outcome === "cancel" || outcome === "finish";
    let replacementBuild: ReturnType<typeof prepareColdBuildGate> | undefined;
    if (!shared) {
      await first.cancel("first request cancelled");
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
      if (outcome === "replace") {
        replacementBuild = prepareColdBuildGate();
      } else {
        await cancellableRun(input).cancel("queued request cancelled");
      }
    }
    const second = cancellableRun(input);
    if (shared) {
      const observed = second.pending.then(
        () => "settled",
        () => "settled",
      );
      await expect(Promise.race([observed, Promise.resolve("pending")])).resolves.toBe("pending");
      await first.cancel("first request cancelled");
    }
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    if (outcome === "cancel") {
      await second.cancel("second request cancelled");
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
      build.release.resolve();
    } else {
      build.release.resolve();
      if (replacementBuild) {
        await replacementBuild.started.promise;
        expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
        expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
        replacementBuild.release.resolve();
      }
      const lease = await second.pending;
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(shared ? 1 : 2);
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
      await lease[Symbol.asyncDispose]();
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
    }
  });

  it("retires model publication before auth snapshots are cleared during restart", async () => {
    mocks.configuredAgentIds = ["default"];
    await refresh({}, { gatewayLifecycle: true });
    const prepared = readSnapshot(configuredInput());
    expect(prepared).toBeDefined();
    await drainGlobalSingletonLifecycleState("restart");
    const builds = mocks.ensureOpenClawModelsJson.mock.calls.length;
    mocks.mutationListener?.({ affectsInheritedStores: true, profileSetChanged: true });
    await nextTurn();
    expect(readSnapshot(configuredInput())).toBeUndefined();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(builds);
    expect(prepared?.isCurrent()).toBe(false);
    await expect(loadPublishedDispatch({ agentId: "default" })).resolves.toBeUndefined();
  });

  it.each(["auth", "config"] as const)(
    "joins the raw %s publication before completing process close",
    async (source) => {
      mocks.configuredAgentIds = ["default"];
      await refresh({}, { gatewayLifecycle: true });
      const { entered, release } = holdModelBuild();
      const published = vi.fn();
      const unregister = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "published") {
          published();
        }
      });
      let refreshWork: Promise<void> | undefined;
      if (source === "auth") {
        mocks.mutationListener?.({ affectsInheritedStores: true });
      } else {
        refreshWork = observe(refresh({}));
      }
      await entered.promise;
      const reader = observe(prepare(configuredInput()));
      const closing = closeProcess();
      try {
        await nextTurn();
        expect(closing.done).toBe(false);
        release.resolve();
        await closing.promise;
        await expect(reader).rejects.toThrow(/closed|superseded/);
        expect(readSnapshot(configuredInput())).toBeUndefined();
        expect(published).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([refreshWork, reader, closing.promise]);
        unregister();
      }
    },
  );

  it("preserves immutable leased data while close drains and allows a fresh standalone activation", async ({
    signal,
  }) => {
    const input = { config: {}, agentDir: fixture.state.agentDir("direct") };
    const options = { retainIdleRunOwner: true, abortSignal: signal };
    const previous = await acquireRun(input, options);
    const closing = closeProcess();
    try {
      await nextTurn(undefined, { signal });
      expect(closing.done).toBe(false);
      expect(previous.snapshot.isCurrent()).toBe(false);
      expect(previous.snapshot.createStores()).toBeDefined();
      await previous[Symbol.asyncDispose]();
      await closing.promise;
      await using next = await acquireRun(input, options);
      expect(next.snapshot).not.toBe(previous.snapshot);
      await previous[Symbol.asyncDispose]();
      expect(readSnapshot(input)).toBe(next.snapshot);
      expect(next.snapshot.isCurrent()).toBe(true);
    } finally {
      await previous[Symbol.asyncDispose]();
      await closing.promise;
    }
  });

  it("does not revive a queued standalone activation after its process lifetime closes", async () => {
    const { entered, release } = holdModelBuild();
    const input = { config: {}, agentDir: fixture.state.agentDir("queued") };
    const first = observe(activate(input));
    await entered.promise;
    const second = observe(activate(input));
    const closing = drainGlobalSingletonLifecycleState("close");
    try {
      release.resolve();
      await closing;
      await expect(first).rejects.toThrow(/closed|superseded/);
      await expect(second).rejects.toThrow(/closed|superseded/);
      expect(readSnapshot(input)).toBeUndefined();
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
    await refresh(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const dispatch = await loadPublishedDispatch({ agentId: "worker" });
    expect(dispatch).toBeDefined();
    const input = {
      ...fixture.agentInput("worker", config),
      workspaceDir: dispatch!.workspaceDir,
      runtimePluginSelections: [{ provider: "xai", modelId: "grok-4.6", runtime: "auto" }],
    };
    const options = { pluginGeneration: dispatch!.pluginGeneration };
    await using outer = await acquireRun(input, options);
    expect(fixture.mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.at(-1)?.[0]).toMatchObject(
      {
        selections: [{ provider: "xai", modelId: "grok-4.6", runtime: "openclaw" }],
      },
    );
    const resolveConfiguredOwner = owners.resolveConfiguredOwner;
    let iterations = 0;
    // Bound the pre-fix microtask livelock; a timer cannot interrupt it.
    using _ = vi.spyOn(owners, "resolveConfiguredOwner").mockImplementation((...args) => {
      if (++iterations > 8) {
        throw new Error("lease admission repeated without completing");
      }
      return resolveConfiguredOwner(...args);
    });
    await using nested = await acquireRun(
      {
        ...input,
        runtimePluginSelections: [{ ...input.runtimePluginSelections[0]!, agentId: "worker" }],
      },
      options,
    );
    expect(nested.snapshot).toBe(outer.snapshot);
    expect(nested.snapshot.isCurrent()).toBe(true);
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
