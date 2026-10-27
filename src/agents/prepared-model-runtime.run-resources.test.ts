import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { cleanupNativeFixture } from "../plugins/native-resource.test-support.js";
import {
  getPluginCache,
  getPluginCacheRetirementSignal,
  getPluginMetadataSnapshotCache,
  resetPluginCache,
  retirePluginCache,
  waitForPluginCacheRetirement,
} from "../plugins/plugin-cache.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import {
  getPluginInstanceOwner,
  type PluginInstanceHandle,
} from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { quiescePluginRegistry } from "../plugins/registry-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createEnteredGate } from "./entered-gate.test-support.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeLease,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { completionModelDefinition } from "./simple-completion.test-support.js";

const providerId = "run-owner-provider";
const siblingId = "run-owner-sibling";
const model = completionModelDefinition({ id: "model", name: "Fixture model" });
const providerCatalog = {
  api: "openai-completions" as const,
  baseUrl: "https://fixture.invalid/v1",
  models: [{ id: model.id, name: model.name, input: model.input }],
};

type Registration = {
  id: string;
  database: DatabaseSync;
  file: string;
  disposals: number;
  store: PluginStateKeyedStore<{ value: number }>;
  instance: PluginInstanceHandle;
};
type RunInput = Parameters<typeof acquireAgentRunPreparedModelRuntime>[0];
type RunOptions = Parameters<typeof acquireAgentRunPreparedModelRuntime>[1];
type Gate = ReturnType<typeof createEnteredGate>;

function registration(records: Registration[], id = providerId, previous?: Registration) {
  return expectDefined(
    records.find((record) => record.id === id && record !== previous),
    `${id} registration`,
  );
}

async function withRunFixture(
  run: (fixture: {
    config: OpenClawConfig;
    input: RunInput;
    registrations: Registration[];
    acquire: (
      options?: RunOptions,
      workspace?: string,
      inputPatch?: Partial<RunInput>,
    ) => Promise<PreparedModelRuntimeLease>;
    original: () => Registration;
    disposal: Gate;
    holdDisposal: () => void;
    catalog: Gate;
  }) => Promise<void>,
  options: {
    catalog?: "hold" | "reject";
    pluginsDisabled?: boolean;
  } = {},
) {
  await withOpenClawTestState({ label: "run-registry-ownership" }, async (state) => {
    const bundled = state.path("bundled");
    fs.mkdirSync(bundled);
    const registrations: Registration[] = [];
    const leases: PreparedModelRuntimeLease[] = [];
    const disposal = createEnteredGate();
    const catalog = createEnteredGate();
    const bridge = {
      registrations,
      captureInstance: () => {
        const instance = expectDefined(
          pluginInstanceInvocation.getStore()?.instance,
          "registering instance",
        );
        return expectDefined(getPluginInstanceOwner(instance)?.instance, "managed instance owner");
      },
      hold: false,
      disposal,
      catalog: options.catalog,
      providers: {},
      catalogGate: catalog,
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
          providerCatalogEntry: options.catalog && id === providerId ? "./catalog.cjs" : undefined,
          modelCatalog: options.catalog
            ? undefined
            : {
                providers: { [id]: { discovery: "static", ...providerCatalog } },
              },
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
  const record = { id: api.id, database, file, disposals: 0, store, instance: bridge.captureInstance() };
  bridge.registrations.push(record);
  api.lifecycle.registerRuntimeLifecycle({ id: "database", async dispose() {
    if (bridge.hold && record === bridge.registrations[0]) {
      await bridge.disposal.wait();
    }
    if (database.prepare("SELECT value FROM answer").get().value !== 42) throw new Error("lost registration state");
    record.disposals++;
    database.close();
  } });
  const provider = { id: api.id, label: api.id, auth: [],
    ...(bridge.catalog && api.id === ${JSON.stringify(providerId)} ? { staticCatalog: { async run() {
      await bridge.catalogGate.wait();
      if (database.prepare("SELECT value FROM answer").get().value !== 42) throw new Error("catalog lost registration state");
      if (bridge.catalog === "reject") throw new Error("fixture static catalog failed");
      return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1", models: [${JSON.stringify(model)}] } };
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
        entries: { main: { workspace: state.workspaceDir } },
        defaults: { workspace: state.workspaceDir, model: `${providerId}/model` },
      },
      models: {
        providers: Object.fromEntries(
          [providerId, siblingId].map((id) => [
            id,
            {
              ...providerCatalog,
              apiKey: "synthetic-run-key",
              models: options.catalog && id === providerId ? [] : [structuredClone(model)],
            },
          ]),
        ),
      },
      plugins: {
        ...(options.pluginsDisabled ? { enabled: false } : {}),
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
            acquire: async (leaseOptions, workspace, inputPatch) => {
              const lease = await acquireAgentRunPreparedModelRuntime(
                {
                  ...input,
                  ...inputPatch,
                  ...(workspace ? { workspaceDir: workspace } : {}),
                },
                leaseOptions,
              );
              leases.push(lease);
              return lease;
            },
            original: () => registration(registrations),
            disposal,
            catalog,
            holdDisposal: () => {
              bridge.hold = true;
            },
          });
        } finally {
          disposal.release();
          catalog.release();
          for (const lease of leases) {
            await lease[Symbol.asyncDispose]();
          }
          await resetPreparedModelRuntimeSnapshotsForTest();
          resetPluginLoaderTestStateForTest();
          cleanupPluginLoaderFixturesForTest();
          clearPluginMetadataLifecycleCaches();
          await closeOpenClawStateDatabaseAsync();
          // The original raw producer has no disposer; fixture cleanup owns those handles.
          cleanupNativeFixture(key, registrations);
        }
      },
    );
  });
}

function readAnswer(record: Registration): unknown {
  return record.database.prepare("SELECT value FROM answer").get()?.value;
}

function expectRetained(record: Registration) {
  expect([readAnswer(record), record.disposals]).toEqual([42, 0]);
}

function expectReopened(record: Registration) {
  const reopened = new DatabaseSync(record.file, { readOnly: true });
  try {
    expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
  } finally {
    reopened.close();
  }
}

function expectDisposed(record: Registration) {
  expect(record.disposals).toBe(1);
  expectReopened(record);
}

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
    const replacement = registration(registrations, providerId, old);
    expectRetained(old);
    await first[Symbol.asyncDispose]();
    await expect.poll(() => old.disposals).toBe(1);
    expect(readAnswer(replacement)).toBe(42);
    const third = await acquire();
    expect(third.snapshot === second.snapshot).toBe(true);
    await second[Symbol.asyncDispose]();
    expectRetained(replacement);
    await third[Symbol.asyncDispose]();
    await expect.poll(() => replacement.disposals).toBe(1);
  });
});

it("keeps shared SDK KV namespaces available across RUN registration retirement", async () => {
  await withRunFixture(async ({ acquire, original, registrations }) => {
    const first = await acquire();
    const old = original();
    const sibling = registration(registrations, siblingId);
    await old.store.register("answer", { value: 42 });
    await sibling.store.register("answer", { value: 84 });
    const shared = openOpenClawStateDatabase().db;
    await first[Symbol.asyncDispose]();
    await expect.poll(() => old.disposals).toBe(1);
    expect(shared.isOpen).toBe(true);
    const next = await acquire();
    const latest = registration(registrations, providerId, old);
    expect((await latest.store.lookup("answer"))?.value).toBe(42);
    expect((await sibling.store.lookup("answer"))?.value).toBe(84);
    expect(openOpenClawStateDatabase().db === shared).toBe(true);
    await latest.store.register("next", { value: 43 });
    await next[Symbol.asyncDispose]();
    await closePreparedModelRuntimeSnapshots();
    expect(shared.isOpen).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    expect(shared.isOpen).toBe(false);
    expect((await latest.store.lookup("next"))?.value).toBe(43);
  });
});

it("process close waits for admitted registration disposal and rejects new RUN admission", async () => {
  await withRunFixture(async ({ acquire, original, holdDisposal, disposal }) => {
    const lease = await acquire();
    holdDisposal();
    let closed = false;
    const closing = closePreparedModelRuntimeSnapshots().then(() => {
      closed = true;
    });
    const leaseReleased = lease[Symbol.asyncDispose]();
    void leaseReleased.catch(() => {});
    try {
      await expect.poll(() => original().database.isOpen && !closed).toBe(true);
      await expect(acquire().then(() => undefined)).rejects.toThrow("process lifetime closed");
      await awaitGateBeforeSettlement(
        disposal.entered,
        closing,
        "Process close finished before registration disposal",
      );
      expect(readAnswer(original())).toBe(42);
      expect(closed).toBe(false);
      expect(original().instance.retainedWorkCount).toBeGreaterThan(0);
    } finally {
      disposal.release();
      await Promise.all([closing, leaseReleased]);
    }
    expectDisposed(original());
    expect(original().instance.retainedWorkCount).toBe(0);
  });
});

it("publishes a replacement while an idle RUN registration is still disposing", async () => {
  await withRunFixture(async ({ acquire, original, config, holdDisposal, disposal }) => {
    const lease = await acquire({ retainIdleRunOwner: true });
    await lease[Symbol.asyncDispose]();
    holdDisposal();
    const built = createDeferredCore();
    let published = false;
    let readConfig: OpenClawConfig | undefined;
    const publication = refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      onBuildStats: () => built.resolve(),
    }).then(() => {
      published = true;
    });
    let reader: Promise<void> | undefined;
    try {
      await disposal.entered;
      reader = loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" }).then((runtime) => {
        readConfig = runtime?.config;
      });
      await built.promise;
      await nextTurn();
      expect.soft(published).toBe(true);
      expect.soft(readConfig).toBe(config);
      expectRetained(original());
    } finally {
      disposal.release();
      await Promise.all([publication, reader]);
    }
    await closePreparedModelRuntimeSnapshots();
    expectDisposed(original());
  });
});

it("preserves eight Gateway RUN retention entries without closing an evicted live lease", async () => {
  await withRunFixture(async ({ config, input, acquire, registrations }) => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const configuredCount = registrations.length;
    const uncovered = { loadRuntimePlugins: true } as const;
    const first = await acquire({}, `${input.workspaceDir}/run-0`, uncovered);
    const oldest = registration(registrations.slice(configuredCount));
    for (let index = 1; index < 9; index++) {
      const lease = await acquire({}, `${input.workspaceDir}/run-${index}`, uncovered);
      await lease[Symbol.asyncDispose]();
    }
    expectRetained(oldest);
    await first[Symbol.asyncDispose]();
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
      async ({ acquire, input, original, catalog: catalogGate }) => {
        const abort = new AbortController();
        const pending = acquire({ abortSignal: abort.signal });
        void pending.catch(() => undefined);
        try {
          await awaitGateBeforeSettlement(
            catalogGate.entered,
            pending,
            "Catalog hook was not entered",
          );
          expect(readAnswer(original())).toBe(42);
          expect(original().instance.retainedWorkCount).toBeGreaterThan(0);
          if (catalog === "hold") {
            abort.abort(new Error("fixture admission cancelled"));
            await expect(pending.then(() => undefined)).rejects.toThrow("aborted");
            expect(getPreparedModelRuntimeSnapshot(input) === undefined).toBe(true);
            expect(original().disposals).toBe(0);
            expect(original().instance.retainedWorkCount).toBeGreaterThan(0);
          }
          catalogGate.release();
          if (catalog === "reject") {
            await expect(pending.then(() => undefined)).rejects.toThrow(
              "fixture static catalog failed",
            );
          }
          await closePreparedModelRuntimeSnapshots();
          expectDisposed(original());
          expect(original().instance.retainedWorkCount).toBe(0);
        } finally {
          catalogGate.release();
          await Promise.allSettled([pending]);
        }
      },
      { catalog },
    );
  },
);

it("joins registered plugin disposal after cache retirement during catalog acquisition", async () => {
  await withRunFixture(
    async ({ acquire, input, original, catalog, holdDisposal, disposal }) => {
      holdDisposal();
      const pending = acquire();
      const acquisition = Promise.allSettled([pending]);
      const metadataRetired = createDeferredCore();
      let closed = false;
      let closing: Promise<unknown> | undefined;
      try {
        await awaitGateBeforeSettlement(
          catalog.entered,
          pending,
          "Catalog acquisition bypassed the registered provider",
        );
        const cache = getPluginCache();
        resetPluginCache();
        expect(getPluginCacheRetirementSignal(cache).aborted).toBe(true);
        // Inspection resources have their own cache; final model close must still
        // join their disposal after the metadata inventory has finished retiring.
        closing = waitForPluginCacheRetirement(true).then(() => {
          metadataRetired.resolve();
          return closePreparedModelRuntimeSnapshots();
        });
        closing = closing.then(() => {
          closed = true;
        });
        await nextTurn();
        expect(closed).toBe(false);
        expectRetained(original());
        catalog.release();
        await awaitGateBeforeSettlement(
          disposal.entered,
          closing,
          "Retirement bypassed the registered plugin disposer",
        );
        await nextTurn();
        await metadataRetired.promise;
        expect(closed).toBe(false);
        expectRetained(original());
        disposal.release();
        await closing;
        expect((await acquisition)[0]?.status).toBe("rejected");
        expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
        expectDisposed(original());
        expect(original().database.isOpen).toBe(false);
      } finally {
        catalog.release();
        disposal.release();
        await Promise.allSettled([pending, closing]);
      }
    },
    { catalog: "hold" },
  );
});

it("retains a managed RUN source borrowed after matching standalone publication reuse", async () => {
  await withRunFixture(async ({ acquire, input, original }) => {
    const first = await acquire();
    const activated = await activateStandalonePreparedModelRuntime(input, {
      catalogMode: "static",
    });
    expect(activated === first.snapshot).toBe(true);
    const borrowed = await acquirePublishedPreparedModelRuntime(input);
    try {
      await first[Symbol.asyncDispose]();
      expectRetained(original());
    } finally {
      await borrowed[Symbol.asyncDispose]();
    }
    await expect.poll(() => original().disposals).toBe(1);
    expectReopened(original());
  });
});

it.each(["registry", "empty inventory"] as const)(
  "rejects a build whose %s retires immediately before publication",
  async (boundary) => {
    await withRunFixture(
      async ({ acquire, original, registrations }) => {
        const lifetime = await import("./prepared-model-runtime.plugin-lifetime.js");
        const publish = lifetime.publishPreparedPluginGeneration;
        let retirement: Promise<unknown> | undefined;
        const publication = vi
          .spyOn(lifetime, "publishPreparedPluginGeneration")
          .mockImplementationOnce((owner, generation) => {
            if (boundary === "registry") {
              quiescePluginRegistry(generation.pluginRegistry);
            } else {
              retirement = retirePluginCache(
                getPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot),
              );
            }
            publish(owner, generation);
          });
        try {
          await expect(acquire().then(() => undefined)).rejects.toThrow(
            "retired before publication",
          );
          expect(publication).toHaveBeenCalledOnce();
          if (boundary === "registry") {
            expect(original().database.isOpen).toBe(false);
            expect(original().disposals).toBe(1);
          } else {
            expect(registrations).toHaveLength(0);
            await retirement;
          }
        } finally {
          publication.mockRestore();
        }
      },
      { pluginsDisabled: boundary === "empty inventory" },
    );
  },
);
