import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeLease,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const providerId = "run-owner-provider";
const siblingId = "run-owner-sibling";

type Registration = {
  id: string;
  mode: string;
  database: DatabaseSync;
  file: string;
  disposals: number;
  store: PluginStateKeyedStore<{ value: number }>;
};

async function withRunFixture(
  run: (fixture: {
    config: OpenClawConfig;
    input: Parameters<typeof acquireAgentRunPreparedModelRuntime>[0];
    registrations: Registration[];
    acquire: (
      options?: Parameters<typeof acquireAgentRunPreparedModelRuntime>[1],
      workspace?: string,
    ) => Promise<PreparedModelRuntimeLease>;
    original: () => Registration;
    finishDisposal: ReturnType<typeof createDeferredCore<void>>;
    disposalStarted: ReturnType<typeof createDeferredCore<void>>;
    holdDisposal: () => void;
    catalogStarted: ReturnType<typeof createDeferredCore<void>>;
    finishCatalog: ReturnType<typeof createDeferredCore<void>>;
  }) => Promise<void>,
  options: { catalog?: "hold" | "reject" } = {},
) {
  await withOpenClawTestState({ label: "run-registry-ownership" }, async (state) => {
    const bundled = state.path("bundled");
    fs.mkdirSync(bundled);
    const registrations: Registration[] = [];
    const leases: PreparedModelRuntimeLease[] = [];
    const finishDisposal = createDeferredCore();
    const disposalStarted = createDeferredCore();
    const catalogStarted = createDeferredCore();
    const finishCatalog = createDeferredCore();
    const bridge = {
      registrations,
      hold: false,
      finishDisposal,
      disposalStarted,
      catalog: options.catalog,
      providers: {},
      catalogStarted,
      finishCatalog,
    };
    const key = `__run_registry_${path.basename(state.root)}`;
    Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
    for (const id of [providerId, siblingId]) {
      const pluginRoot = path.join(bundled, id);
      fs.mkdirSync(pluginRoot);
      const plugin = createColdPluginFixture({
        rootDir: pluginRoot,
        pluginId: id,
        providerId: id,
        manifest: {
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          ...(options.catalog && id === providerId
            ? { providerCatalogEntry: "./catalog.cjs" }
            : {}),
          ...(!options.catalog
            ? {
                modelCatalog: {
                  providers: {
                    [id]: {
                      discovery: "static",
                      api: "openai-completions",
                      baseUrl: "https://fixture.invalid/v1",
                      models: [{ id: "model", name: "Fixture model", input: ["text"] }],
                    },
                  },
                },
              }
            : {}),
        },
      });
      fs.writeFileSync(
        plugin.runtimeSource,
        `
const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const bridge = globalThis[${JSON.stringify(key)}];
  const file = ${JSON.stringify(state.root)} + "/registration-" + bridge.registrations.length + ".sqlite";
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
  const store = api.runtime.state.openKeyedStore({ namespace: "run-proof", maxEntries: 20 });
  const record = { id: api.id, mode: api.registrationMode, database, file, disposals: 0, store };
  bridge.registrations.push(record);
  api.lifecycle.registerRuntimeLifecycle({ id: "database", async dispose() {
    if (bridge.hold && record === bridge.registrations[0]) {
      bridge.disposalStarted.resolve();
      await bridge.finishDisposal.promise;
    }
    if (database.prepare("SELECT value FROM answer").get().value !== 42) throw new Error("lost registration state");
    record.disposals++;
    database.close();
  } });
  const provider = { id: api.id, label: api.id, auth: [],
    ...(bridge.catalog && api.id === ${JSON.stringify(providerId)} ? { staticCatalog: { async run() {
      bridge.catalogStarted.resolve();
      await bridge.finishCatalog.promise;
      if (database.prepare("SELECT value FROM answer").get().value !== 42) throw new Error("catalog lost registration state");
      if (bridge.catalog === "reject") throw new Error("fixture static catalog failed");
      return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1", models: [{ id: "model", name: "Fixture model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } };
    } } } : {})
  };
  bridge.providers[api.id] = provider;
  api.registerProvider(provider);
} };
`,
      );
      if (options.catalog && id === providerId) {
        fs.writeFileSync(
          path.join(pluginRoot, "catalog.cjs"),
          `module.exports = globalThis[${JSON.stringify(key)}].providers[${JSON.stringify(id)}];`,
        );
      }
    }
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { default: true, workspace: state.workspaceDir } },
        defaults: { workspace: state.workspaceDir, model: `${providerId}/model` },
      },
      models: {
        providers: Object.fromEntries(
          [providerId, siblingId].map((id) => [
            id,
            {
              api: "openai-completions" as const,
              apiKey: "synthetic-run-key",
              baseUrl: "https://fixture.invalid/v1",
              models:
                options.catalog && id === providerId
                  ? []
                  : [
                      {
                        id: "model",
                        name: "Fixture model",
                        reasoning: false,
                        input: ["text" as const],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 8192,
                        maxTokens: 1024,
                      },
                    ],
            },
          ]),
        ),
      },
      plugins: {
        allow: [providerId, siblingId],
        slots: { memory: "none" },
        entries: { [providerId]: { enabled: true }, [siblingId]: { enabled: true } },
      },
    };
    const input = {
      config,
      agentId: "main",
      agentDir: state.agentDir("main"),
      workspaceDir: state.workspaceDir,
      runtimePluginSelections: [{ provider: providerId, modelId: "model", agentId: "main" }],
    };
    await withEnvAsync(
      { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
      async () => {
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearPluginMetadataLifecycleCaches();
        try {
          await run({
            config,
            input,
            registrations,
            acquire: async (leaseOptions, workspace) => {
              const lease = await acquireAgentRunPreparedModelRuntime(
                { ...input, ...(workspace ? { workspaceDir: workspace } : {}) },
                leaseOptions,
              );
              leases.push(lease);
              return lease;
            },
            original: () =>
              expectDefined(
                registrations.find((record) => record.id === providerId),
                "selected provider registration",
              ),
            finishDisposal,
            disposalStarted,
            catalogStarted,
            finishCatalog,
            holdDisposal: () => {
              bridge.hold = true;
            },
          });
        } finally {
          finishDisposal.resolve();
          finishCatalog.resolve();
          for (const lease of leases) {
            lease.release();
          }
          await resetPreparedModelRuntimeSnapshotsForTest();
          resetPluginLoaderTestStateForTest();
          cleanupPluginLoaderFixturesForTest();
          clearPluginMetadataLifecycleCaches();
          closeOpenClawStateDatabase();
          for (const record of registrations) {
            // The original raw producer has no disposer; fixture cleanup owns those handles.
            if (record.database.isOpen) {
              record.database.close();
            }
          }
          delete (globalThis as Record<string, unknown>)[key];
        }
      },
    );
  });
}

function readAnswer(record: Registration): unknown {
  return record.database.prepare("SELECT value FROM answer").get()?.value;
}

function expectReopened(record: Registration) {
  const reopened = new DatabaseSync(record.file, { readOnly: true });
  try {
    expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
  } finally {
    reopened.close();
  }
}

it("keeps overlapping RUN callers on one registration and closes only after the last release", async () => {
  await withRunFixture(async ({ acquire, original, registrations }) => {
    const first = await acquire();
    const count = registrations.length;
    const second = await acquire();
    expect(first.snapshot === second.snapshot).toBe(true);
    expect(registrations.length).toBe(count);
    expect(original().mode).toBe("discovery");
    first.release();
    await nextTurn();
    expect(readAnswer(original())).toBe(42);
    expect(original().disposals).toBe(0);
    second.release();
    await expect.poll(() => original().disposals).toBe(1);
    expect(original().database.isOpen).toBe(false);
    expectReopened(original());
  });
});

it("retains a replaced RUN generation without letting its release retire the replacement", async () => {
  await withRunFixture(async ({ acquire, input, original, registrations }) => {
    const first = await acquire();
    const old = original();
    await publishPreparedModelRuntimeSnapshot(input, {
      provenance: "run",
      catalogMode: "static",
      force: true,
    });
    const second = await acquire();
    expect(first.snapshot === second.snapshot).toBe(false);
    const replacement = expectDefined(
      registrations.find((record) => record.id === providerId && record !== old),
      "replacement registration",
    );
    expect(readAnswer(old)).toBe(42);
    expect(old.disposals).toBe(0);
    first.release();
    await expect.poll(() => old.disposals).toBe(1);
    expect(readAnswer(replacement)).toBe(42);
    const third = await acquire();
    expect(third.snapshot === second.snapshot).toBe(true);
    second.release();
    third.release();
    await expect.poll(() => replacement.disposals).toBe(1);
  });
});

it("preserves the direct one-entry idle retention policy across RUN eviction", async () => {
  await withRunFixture(async ({ acquire, original, input }) => {
    const first = await acquire({ retainIdleRunOwner: true });
    first.release();
    await nextTurn();
    expect(readAnswer(original())).toBe(42);
    const warm = await acquire({ retainIdleRunOwner: true });
    expect(warm.snapshot === first.snapshot).toBe(true);
    const next = await acquire({ retainIdleRunOwner: true }, `${input.workspaceDir}/next`);
    expect(readAnswer(original())).toBe(42);
    warm.release();
    await expect.poll(() => original().disposals).toBe(1);
    next.release();
  });
});

it("keeps shared SDK KV namespaces available across RUN registration retirement", async () => {
  await withRunFixture(async ({ acquire, original, registrations }) => {
    const first = await acquire();
    const old = original();
    const sibling = expectDefined(
      registrations.find((record) => record.id === siblingId),
      "sibling plugin registration",
    );
    await old.store.register("answer", { value: 42 });
    await sibling.store.register("answer", { value: 84 });
    const shared = openOpenClawStateDatabase().db;
    first.release();
    await expect.poll(() => old.disposals).toBe(1);
    expect(shared.isOpen).toBe(true);
    const next = await acquire();
    const latest = expectDefined(
      registrations.find((record) => record.id === providerId && record !== old),
      "next SDK state user",
    );
    expect((await latest.store.lookup("answer"))?.value).toBe(42);
    expect((await sibling.store.lookup("answer"))?.value).toBe(84);
    expect(openOpenClawStateDatabase().db === shared).toBe(true);
    await latest.store.register("next", { value: 43 });
    next.release();
    await closePreparedModelRuntimeSnapshots();
    expect(shared.isOpen).toBe(true);
    closeOpenClawStateDatabase();
    expect(shared.isOpen).toBe(false);
    expect((await latest.store.lookup("next"))?.value).toBe(43);
  });
});

it("process close waits for admitted registration disposal and rejects new RUN admission", async () => {
  await withRunFixture(
    async ({ acquire, original, holdDisposal, disposalStarted, finishDisposal }) => {
      const lease = await acquire();
      holdDisposal();
      let closed = false;
      const closing = closePreparedModelRuntimeSnapshots().then(() => {
        closed = true;
      });
      lease.release();
      try {
        await expect.poll(() => original().database.isOpen && !closed).toBe(true);
        await expect(acquire().then(() => undefined)).rejects.toThrow("process lifetime closed");
        await Promise.race([
          disposalStarted.promise,
          closing.then(() => {
            throw new Error("Process close finished before registration disposal");
          }),
        ]);
        expect(readAnswer(original())).toBe(42);
        expect(closed).toBe(false);
      } finally {
        finishDisposal.resolve();
        await closing;
      }
      expect(original().disposals).toBe(1);
      expectReopened(original());
    },
  );
});

it("keeps configured registry identity and its raw resources under the configured owner", async () => {
  await withRunFixture(async ({ config, acquire, original }) => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const first = await acquire();
    const raw = original();
    const second = await acquire();
    expect(first.snapshot === second.snapshot).toBe(true);
    first.release();
    second.release();
    await closePreparedModelRuntimeSnapshots();
    expect(raw.disposals).toBe(0);
    expect(readAnswer(raw)).toBe(42);
  });
});

it("preserves eight Gateway RUN retention entries without closing an evicted live lease", async () => {
  await withRunFixture(async ({ config, input, acquire, registrations }) => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const configuredCount = registrations.length;
    const first = await acquire({}, `${input.workspaceDir}/run-0`);
    const oldest = expectDefined(
      registrations.slice(configuredCount).find((record) => record.id === providerId),
      "first dynamic registration",
    );
    for (let index = 1; index < 9; index++) {
      const lease = await acquire({}, `${input.workspaceDir}/run-${index}`);
      lease.release();
    }
    expect(readAnswer(oldest)).toBe(42);
    expect(oldest.disposals).toBe(0);
    first.release();
    await expect.poll(() => oldest.disposals).toBe(1);
    expect(
      registrations
        .slice(configuredCount)
        .filter((record) => record.id === providerId && record.database.isOpen).length,
    ).toBe(8);
    await closePreparedModelRuntimeSnapshots();
    expect(registrations.slice(configuredCount).every((record) => record.disposals === 1)).toBe(
      true,
    );
    expect(registrations.slice(0, configuredCount).every((record) => record.disposals === 0)).toBe(
      true,
    );
  });
});

it.each(["hold", "reject"] as const)(
  "keeps an ordinary RUN static catalog source through %s build settlement",
  async (catalog) => {
    await withRunFixture(
      async ({ acquire, input, original, catalogStarted, finishCatalog }) => {
        const abort = new AbortController();
        const pending = acquire({ abortSignal: abort.signal });
        void pending.catch(() => undefined);
        try {
          await Promise.race([
            catalogStarted.promise,
            pending.then(() => {
              throw new Error("Catalog hook was not entered");
            }),
          ]);
          expect(readAnswer(original())).toBe(42);
          if (catalog === "hold") {
            abort.abort(new Error("fixture admission cancelled"));
            await expect(pending.then(() => undefined)).rejects.toThrow("aborted");
            expect(getPreparedModelRuntimeSnapshot(input) === undefined).toBe(true);
            expect(original().disposals).toBe(0);
          }
          finishCatalog.resolve();
          if (catalog === "reject") {
            await expect(pending.then(() => undefined)).rejects.toThrow(
              "fixture static catalog failed",
            );
          }
          await closePreparedModelRuntimeSnapshots();
          expect(original().disposals).toBe(1);
          expectReopened(original());
        } finally {
          finishCatalog.resolve();
          await Promise.allSettled([pending]);
        }
      },
      { catalog },
    );
  },
);

it("retains a managed RUN source borrowed after matching standalone publication reuse", async () => {
  await withRunFixture(async ({ acquire, input, original }) => {
    const first = await acquire();
    const activated = await activateStandalonePreparedModelRuntime(input, {
      catalogMode: "static",
    });
    expect(activated === first.snapshot).toBe(true);
    const borrowed = await acquirePublishedPreparedModelRuntime(input);
    try {
      first.release();
      expect(readAnswer(original())).toBe(42);
      expect(original().disposals).toBe(0);
    } finally {
      borrowed.release();
    }
    await expect.poll(() => original().disposals).toBe(1);
    expectReopened(original());
  });
});
