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

async function fixture() {
  const installation = await createClaudeInstallationFixture(temps.make("claude-readiness-"));
  const api = createTestPluginApi();
  Object.assign(api.runtime, {
    state: {
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
        expect(options.env?.OPENCLAW_STATE_DIR).toBe(installation.context.env.OPENCLAW_STATE_DIR);
        return createPluginStateKeyedStoreForTests<T>("anthropic", options);
      },
    },
  });
  const invalidate = vi.fn();
  const create = () => createClaudeCliReadiness(api, invalidate);
  const context: CliBackendModelCatalogContext = {
    ...installation.context,
    cwd: installation.home,
    signal: new AbortController().signal,
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
  it("repairs discovery once for concurrent consumers and serves repeat reads without CLI work", async () => {
    const f = await fixture();
    const prepare = f.create();
    const results = await Promise.all([prepare(f.context), prepare(f.context)]);
    for (const result of results) {
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
      reason: expect.stringContaining("not known"),
    });
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
      const f = await fixture();
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

  it("assesses a newly discovered requirement immediately after an older model was ready", async () => {
    const f = await fixture();
    const prepare = f.create();
    expect(
      (await prepare({ ...f.context, modelIds: ["claude-opus-5"] })).models["claude-opus-5"]
        ?.available,
    ).toBe(true);
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
