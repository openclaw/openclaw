import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import type { CliBackendModelCatalogContext } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeInstallationFixture } from "./cli-installation.test-helpers.js";
import { createClaudeCliReadiness } from "./cli-readiness.js";

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
const model = "claude-opus-5-5";

async function fixture(
  signal = new AbortController().signal,
  afterCooldownClaim?: () => Promise<void>,
) {
  const installation = await createClaudeInstallationFixture(temps.make("claude-readiness-"));
  const api = createTestPluginApi();
  Object.assign(api.runtime, {
    state: {
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
        expect(options.env?.OPENCLAW_STATE_DIR).toBe(installation.context.env.OPENCLAW_STATE_DIR);
        const store = createPluginStateKeyedStoreForTests<T>("anthropic", options);
        if (options.namespace !== "claude-cli-compatibility" || !afterCooldownClaim) {
          return store;
        }
        return {
          ...store,
          withCurrent: (authority: Parameters<NonNullable<typeof store.withCurrent>>[0]) => {
            const current = store.withCurrent!(authority);
            return {
              ...current,
              compareAndApply: async (...args: Parameters<typeof current.compareAndApply>) => {
                const result = await current.compareAndApply(...args);
                await afterCooldownClaim();
                return result;
              },
            };
          },
        };
      },
    },
  });
  const invalidate = vi.fn();
  const create = () => createClaudeCliReadiness(api, invalidate);
  const context: CliBackendModelCatalogContext = {
    ...installation.context,
    cwd: installation.home,
    signal,
    modelIds: [model],
    reason: "discovery",
    withMaintenance: (update) => update(),
  };
  return {
    ...installation,
    context,
    invalidate,
    create,
    updates: async () => (await installation.calls()).filter(({ args }) => args[0] === "update"),
  };
}

// These executable fixtures cover the supported macOS/Linux automatic update path.
describe.skipIf(process.platform === "win32")("Claude CLI readiness", () => {
  it("cancels a waiting caller without interrupting shared repair or repeating CLI work", async ({
    signal,
  }) => {
    const lifetime = new AbortController();
    const f = await fixture(AbortSignal.any([signal, lifetime.signal]));
    const prepare = f.create();
    const completed = createDeferred<void>();
    const release = createDeferred<void>();
    const owner = prepare({
      ...f.context,
      withMaintenance: async (update) => {
        const result = await update();
        completed.resolve();
        await release.promise;
        return result;
      },
    });
    const controller = new AbortController();
    const waiters: ReturnType<typeof prepare>[] = [];
    try {
      await withinTest(
        awaitGateBeforeSettlement(completed.promise, owner, "Repair did not reach settlement"),
        signal,
      );
      const cancelled = prepare({ ...f.context, signal: controller.signal });
      const survivor = prepare(f.context);
      waiters.push(cancelled, survivor);
      let waiterSettled = false;
      const failure = cancelled
        .catch((error: unknown) => error)
        .finally(() => {
          waiterSettled = true;
        });
      controller.abort(new Error("Waiting turn cancelled"));
      // Abort rejection is local: drain promise reactions before releasing the owner.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(waiterSettled).toBe(true);
      expect(await failure).toMatchObject({ name: "AbortError" });
      expect(f.context.signal.aborted).toBe(false);
      release.resolve();
      for (const result of await Promise.all([owner, survivor])) {
        expect(result.models[model]).toEqual({ available: true });
        expect(result.runtimeVersion).toBe("2.1.286");
      }
      expect(await f.updates()).toHaveLength(1);
      expect(f.invalidate).toHaveBeenCalledOnce();
      const invocations = (await f.calls()).length;
      expect((await prepare({ ...f.context, reason: "routine" })).models[model]?.available).toBe(
        true,
      );
      expect((await f.calls()).length).toBe(invocations);
      const unknown = await prepare({ ...f.context, modelIds: ["claude-future-99"] });
      expect(unknown.models["claude-future-99"]).toMatchObject({
        available: false,
        compatibility: "unknown",
        reason: expect.stringContaining("not known"),
      });
      expect(await f.updates()).toHaveLength(1);
    } finally {
      lifetime.abort(new Error("Readiness test finished"));
      release.resolve();
      await Promise.allSettled([owner, ...waiters]);
    }
  });

  it.for(["abort", "retired authority", "operation failure"] as const)(
    "settles live readiness waiters after owner $0",
    async (failure, { signal }) => {
      const f = await fixture(signal);
      const prepare = f.create();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const controller = new AbortController();
      const error = new Error(`Readiness owner ${failure}`);
      let current = true;
      const owner = prepare({
        ...f.context,
        signal: AbortSignal.any([signal, controller.signal]),
        assertCurrent: () => {
          if (!current) {
            throw error;
          }
        },
        withMaintenance: async (update) => {
          entered.resolve();
          await release.promise;
          if (failure === "operation failure") {
            throw error;
          }
          return update();
        },
      });
      const ownerResult = owner.catch((reason: unknown) => reason);
      let survivor: ReturnType<typeof prepare> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, owner, "Owner did not enter maintenance"),
          signal,
        );
        survivor = prepare({ ...f.context, reason: "manual" });
        const survivorResult = survivor.catch((reason: unknown) => reason);
        if (failure === "abort") {
          controller.abort(error);
        } else if (failure === "retired authority") {
          current = false;
        }
        release.resolve();
        expect(await withinTest(ownerResult, signal)).toBe(error);
        if (failure === "operation failure") {
          expect(await withinTest(survivorResult, signal)).toBe(error);
          expect(await f.updates()).toHaveLength(0);
        } else {
          expect(await withinTest(survivorResult, signal)).toMatchObject({
            models: { [model]: { available: true } },
            runtimeVersion: "2.1.286",
          });
          expect(await f.updates()).toHaveLength(1);
        }
      } finally {
        controller.abort();
        release.resolve();
        await Promise.allSettled([owner, ...(survivor ? [survivor] : [])]);
      }
    },
  );

  it.for([0o755, 0o777])(
    "admits an updated native launcher only after verifying mode %i",
    async (mode, { signal }) => {
      const f = await fixture(signal);
      await fs.chmod(f.next, mode);
      const result = await f.create()(f.context);
      expect(await f.updates()).toHaveLength(1);
      if (mode === 0o755) {
        expect(result.models[model]).toEqual({ available: true });
        expect(result.runtimeVersion).toBe("2.1.286");
      } else {
        const calls = await f.calls();
        const updateIndex = calls.findIndex(({ args }) => args[0] === "update");
        expect(calls.slice(updateIndex + 1)).not.toContainEqual(
          expect.objectContaining({ args: ["--version"] }),
        );
        expect(result.models[model]).toMatchObject({
          available: false,
          reason: expect.stringContaining("could not be verified"),
        });
        expect(result.runtimeVersion).toBeUndefined();
      }
      expect(f.invalidate).toHaveBeenCalledOnce();
    },
  );

  it("keeps rejected replacements blocked across owner, generation and command identity changes", async ({
    signal,
  }) => {
    const f = await fixture(signal);
    await fs.chmod(f.next, 0o777);
    await f.create()(f.context);
    const calls = (await f.calls()).length;
    const cooldowns = createPluginStateKeyedStoreForTests("anthropic", {
      namespace: "claude-cli-compatibility",
      maxEntries: 64,
      env: f.context.env,
    });
    for (let index = 0; index < 65; index++) {
      await cooldowns.register(`other-installation-${index}`, { attemptedAt: index });
    }
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const restarted = f.create();
    const context = {
      ...f.context,
      command: f.launcher,
      cwd: f.root,
      env: { ...f.context.env, PATH: `${f.context.env.PATH}:/usr/bin` },
      runtimeGeneration: 2,
    };
    const rejected = await restarted(context);
    expect(rejected.models[model]?.available).toBe(false);
    expect(rejected.runtimeVersion).toBeUndefined();
    expect((await f.calls()).length).toBe(calls);
    // An operator repair of the same launcher restores compatibility without reinstalling.
    await fs.chmod(f.next, 0o755);
    const repaired = await restarted({ ...context, reason: "manual" });
    expect(repaired.models[model]).toEqual({ available: true });
    expect(repaired.runtimeVersion).toBe("2.1.286");
    expect(await f.updates()).toHaveLength(1);
  });

  it("rechecks an intervening failed replacement after waiting for maintenance", async ({
    signal,
  }) => {
    const f = await fixture(signal);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const waiting = f.create()({
      ...f.context,
      withMaintenance: async (update) => {
        entered.resolve();
        await release.promise;
        return update();
      },
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, waiting, "Maintenance did not wait"),
        signal,
      );
      await fs.chmod(f.next, 0o777);
      await f.create()(f.context);
      const calls = (await f.calls()).length;
      release.resolve();
      expect((await waiting).models[model]?.available).toBe(false);
      expect((await f.calls()).length).toBe(calls);
      expect(await f.updates()).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([waiting]);
    }
  });

  it("does not replace a competing verification owner claimed after maintenance admission", async ({
    signal,
  }) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const f = await fixture(signal, async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = f.create()(f.context);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, pending, "Cooldown was not claimed"),
        signal,
      );
      const markers = createPluginStateKeyedStoreForTests("anthropic", {
        namespace: "claude-cli-verification",
        maxEntries: 64,
        overflowPolicy: "reject-new",
        env: f.context.env,
      });
      const key = createHash("sha256").update(f.launcher).digest("hex");
      const competing = {
        attemptId: "other-live-owner",
        installationKey: "other-installation",
        pendingUntil: Date.now() + 30 * 60_000,
      };
      await markers.register(key, competing);
      release.resolve();
      expect((await pending).models[model]?.available).toBe(false);
      expect(await f.updates()).toHaveLength(0);
      expect(await fs.realpath(f.launcher)).toBe(f.previous);
      expect(await markers.lookup(key)).toEqual(competing);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("refuses a new automatic mutation when verification storage is full", async ({ signal }) => {
    const f = await fixture(signal);
    const markers = createPluginStateKeyedStoreForTests("anthropic", {
      namespace: "claude-cli-verification",
      maxEntries: 64,
      overflowPolicy: "reject-new",
      env: f.context.env,
    });
    for (let index = 0; index < 64; index++) {
      await markers.register(`outstanding-${index}`, {
        attemptId: String(index),
        installationKey: String(index),
        pendingUntil: 0,
      });
    }
    await expect(f.create()(f.context)).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    expect(await f.updates()).toHaveLength(0);
    expect(await fs.realpath(f.launcher)).toBe(f.previous);
  });

  it("preserves compatible pinned commands that have never been automatically updated", async ({
    signal,
  }) => {
    const f = await fixture(signal);
    const result = await f.create()({ ...f.context, command: f.next });
    expect(result.models[model]).toEqual({ available: true });
    expect(result.runtimeVersion).toBe("2.1.286");
    expect(await f.updates()).toHaveLength(0);
  });

  it("retains compatibility of the verified old launcher after a failed installer", async ({
    signal,
  }) => {
    const f = await fixture(signal);
    await f.change({ fail: true });
    const result = await f.create()({ ...f.context, modelIds: [model, "claude-haiku-4-5"] });
    expect(result.models[model]).toMatchObject({ available: false });
    expect(result.models["claude-haiku-4-5"]).toEqual({ available: true });
    expect(result.runtimeVersion).toBe("2.1.269");
    expect(await f.updates()).toHaveLength(1);
  });

  it("invalidates the shared version observation when its owner retires after launcher mutation", async ({
    signal,
  }) => {
    const f = await fixture(signal);
    const retired = new Error("Owner retired after installing the new launcher");
    await expect(
      f.create()({
        ...f.context,
        assertCurrent: () => {
          if (realpathSync(f.launcher) === f.next) {
            throw retired;
          }
        },
      }),
    ).rejects.toBe(retired);
    expect(await fs.realpath(f.launcher)).toBe(f.next);
    expect(await f.updates()).toHaveLength(1);
    expect(f.invalidate).toHaveBeenCalledOnce();
    const calls = (await f.calls()).length;
    expect((await f.create()(f.context)).models[model]?.available).toBe(false);
    expect((await f.calls()).length).toBe(calls);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000 + 1);
    expect((await f.create()(f.context)).models[model]?.available).toBe(true);
    expect(await f.updates()).toHaveLength(1);
  });

  it("keeps failed attempts across owner restart and lets an explicit manual refresh repair them", async () => {
    const f = await fixture();
    await f.change({ fail: true });
    expect((await f.create()(f.context)).models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(1);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await f.change({ fail: false });
    const restarted = f.create();
    expect((await restarted(f.context)).models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(1);
    expect((await restarted({ ...f.context, reason: "manual" })).models[model]?.available).toBe(
      true,
    );
    expect(await f.updates()).toHaveLength(2);
  });

  it.for([
    { automaticReady: false, manualReady: true },
    { automaticReady: false, manualReady: false },
    { automaticReady: true, manualReady: true },
  ])(
    "honors pending manual refreshes after automatic readiness=$automaticReady, manual readiness=$manualReady",
    async ({ automaticReady, manualReady }, { signal }) => {
      const lifetime = new AbortController();
      const f = await fixture(AbortSignal.any([signal, lifetime.signal]));
      await f.change({ fail: !automaticReady });
      const prepare = f.create();
      const completed = createDeferred<void>();
      const release = createDeferred<void>();
      const automatic = prepare({
        ...f.context,
        withMaintenance: async (update) => {
          const result = await update();
          completed.resolve();
          await release.promise;
          return result;
        },
      });
      const waiters: ReturnType<typeof prepare>[] = [];
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            completed.promise,
            automatic,
            "Automatic update did not reach settlement",
          ),
          signal,
        );
        await f.change({ fail: !manualReady });
        const invocations = (await f.calls()).length;
        const enteredMaintenance = vi.fn();
        const manualContext: CliBackendModelCatalogContext = {
          ...f.context,
          reason: "manual",
          withMaintenance: (update) => {
            enteredMaintenance();
            return f.context.withMaintenance!(update);
          },
        };
        waiters.push(prepare(manualContext), prepare(manualContext), prepare(f.context));
        release.resolve();
        const [automaticResult, firstManual, secondManual, discovery] = await Promise.all([
          automatic,
          ...waiters,
        ]);
        expect(automaticResult.models[model]?.available).toBe(automaticReady);
        expect(discovery?.models[model]?.available).toBe(automaticReady);
        expect(firstManual?.models[model]?.available).toBe(manualReady);
        expect(secondManual?.models[model]?.available).toBe(manualReady);
        expect(enteredMaintenance).toHaveBeenCalledTimes(automaticReady ? 0 : 1);
        expect(await f.updates()).toHaveLength(automaticReady ? 1 : 2);
        if (automaticReady) {
          expect((await f.calls()).length).toBe(invocations);
        }
      } finally {
        lifetime.abort(new Error("Readiness test finished"));
        release.resolve();
        await Promise.allSettled([automatic, ...waiters]);
      }
    },
  );

  it("serves a durable failure cooldown without entering maintenance or repeating probes", async () => {
    const f = await fixture();
    await f.change({ fail: true });
    await f.create()(f.context);
    const enteredMaintenance = vi.fn();
    const restarted = f.create();
    const context: CliBackendModelCatalogContext = {
      ...f.context,
      runtimeGeneration: 1,
      withMaintenance: (update) => {
        enteredMaintenance();
        return f.context.withMaintenance!(update);
      },
    };
    expect((await restarted(context)).models[model]?.available).toBe(false);
    expect(enteredMaintenance).not.toHaveBeenCalled();
    const invocations = (await f.calls()).length;
    expect((await restarted(context)).models[model]?.available).toBe(false);
    expect((await f.calls()).length).toBe(invocations);
    expect(await f.updates()).toHaveLength(1);
  });

  it("preserves supported Haiku aliases and dated snapshots while inheriting version requirements", async () => {
    const f = await fixture();
    await f.change({ noChange: true });
    const ids = [
      "haiku",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5-20261001",
      "claude-opus-99-20261001",
    ];
    const result = await f.create()({ ...f.context, modelIds: ids });
    for (const id of ids.slice(0, 3)) {
      expect(result.models[id]).toEqual({ available: true });
    }
    expect(result.models[ids[3]!]).toMatchObject({
      available: false,
      reason: expect.stringContaining("requires 2.1.280"),
    });
    expect(result.models[ids[3]!]).not.toHaveProperty("compatibility");
    expect(result.models[ids[4]!]).toMatchObject({
      available: false,
      reason: expect.stringContaining("not known"),
    });
    expect(await f.updates()).toHaveLength(1);
  });

  it("does not publish an ineffective update as ready or retry it before the daily deadline", async () => {
    const f = await fixture();
    await f.change({ noChange: true });
    const prepare = f.create();
    const result = await prepare(f.context);
    expect(result.models[model]).toMatchObject({
      available: false,
      reason: expect.stringContaining("requires 2.1.280"),
    });
    expect((await prepare(f.context)).models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(1);
    await f.change({ noChange: false });
    vi.spyOn(Date, "now").mockReturnValue(result.nextCheckAt! + 1);
    expect((await prepare({ ...f.context, reason: "routine" })).models[model]?.available).toBe(
      true,
    );
    expect(await f.updates()).toHaveLength(2);
  });

  it("preserves unknown configured IDs without verifying them or bypassing a newly discovered requirement", async () => {
    const f = await fixture();
    const prepare = f.create();
    const result = await prepare({
      ...f.context,
      modelIds: ["claude-opus-5", "claude-future-99"],
    });
    expect(result.models["claude-opus-5"]?.available).toBe(true);
    expect(result.models["claude-future-99"]).toMatchObject({
      available: false,
      compatibility: "unknown",
    });
    expect(result.runtimeVersion).toBe("2.1.269");
    expect(await f.updates()).toHaveLength(0);
    expect((await prepare(f.context)).models[model]?.available).toBe(true);
    expect(await f.updates()).toHaveLength(1);
  });

  it("defers repair during active use and repairs when maintenance is admitted without a cooldown", async () => {
    const f = await fixture();
    const prepare = f.create();
    const blocked = await prepare({ ...f.context, withMaintenance: async () => undefined });
    expect(blocked.models[model]?.available).toBe(false);
    expect(await f.updates()).toHaveLength(0);
    expect(blocked.nextCheckAt).toBeLessThan(Date.now() + 60_000);
    vi.spyOn(Date, "now").mockReturnValue(blocked.nextCheckAt! + 1);
    expect((await prepare(f.context)).models[model]?.available).toBe(true);
    expect(await f.updates()).toHaveLength(1);
  });
});
