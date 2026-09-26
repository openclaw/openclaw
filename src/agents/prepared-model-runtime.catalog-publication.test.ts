// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPreparedServerMethodModelCatalogs } from "../gateway/server-methods/optional-model-catalog.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "../gateway/server-methods/sessions-read-cache.test-support.js";
import { readPreparedGatewayModelCatalog } from "../gateway/server-model-catalog.js";
import * as projectionWork from "../gateway/session-projection-work.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../gateway/session-row-projection.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  recordRuntimeAuthMaterialization,
  revokeRuntimeAuthMaterializations,
} from "./auth-profiles/runtime-materializations.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthMaterializations,
} from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "catalog-publication-rows", scenario: "minimal" },
  () => {
    projection?.dispose();
    projection = undefined;
    vi.restoreAllMocks();
  },
);
const { mocks } = fixture;
const rowCount = 256;
const model: ModelCatalogEntry = {
  provider: "custom",
  id: "synthetic-model",
  name: "Synthetic model",
  contextWindow: 32_000,
  reasoning: false,
  input: ["text"],
};
let projection: SessionRowProjection | undefined;

// Worker replies are fresh objects, as across the real worker serialization boundary.
function catalog(entry: ModelCatalogEntry | undefined = model): ModelCatalogSnapshot {
  const entries = entry ? [structuredClone(entry)] : [];
  return {
    entries,
    routeVariants: structuredClone(entries),
    providerOutcomes: [{ provider: "custom", status: "ready" }],
  };
}

// Real catalog publication, persisted rows, projection, and the registered RPC share one owner.
async function setup(preparedMap = false, profile?: AuthProfileCredential) {
  const config: OpenClawConfig = {
    agents: {
      list: [{ id: "default", default: true }],
      defaults: { model: "custom/synthetic-model" },
    },
  };
  mocks.configuredAgentIds = ["default"];
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => catalog());
  const input = { config, agentId: "default", agentDir: fixture.state.agentDir("default") };
  if (profile) {
    mocks.usePersistedAuthProfiles = true;
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());
    persistProfile(profile);
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  }
  let owner = profile
    ? await prepareModelRuntimeSnapshot(input)
    : await publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
  await owner.loadFullModelCatalog!({ refresh: true });
  runOpenClawAgentWriteTransaction(
    () => {
      for (let index = 0; index < rowCount; index++) {
        replaceSessionEntrySync(
          { agentId: "default", sessionKey: `agent:default:row-${index}` },
          {
            sessionId: `session-${index}`,
            updatedAt: index + 1,
            label: `Row ${index}`,
            modelProvider: "custom",
            model: "synthetic-model",
            visibility: "shared",
          },
        );
      }
    },
    { agentId: "default" },
  );
  const context = requestContext(config);
  const readPrepared = vi.fn(() =>
    readPreparedGatewayModelCatalog({ agentId: "default", getConfig: () => config }),
  );
  context.readPreparedGatewayModelCatalog = readPrepared;
  const readCatalog = vi.fn(async () =>
    preparedMap
      ? readPreparedServerMethodModelCatalogs(context, ["default"])
      : (owner.readFullModelCatalog?.() ?? owner.modelCatalog).entries,
  );
  projection = await createSessionRowProjection({
    cfg: config,
    getConfig: () => config,
    getModelCatalog: readCatalog,
  });
  const rows = projection;
  bindSessionRowProjection(context, () => rows);
  const client = identifiedClient("synthetic-viewer");
  const list = () =>
    listSessions({ context, client, request: { limit: rowCount, archived: "all" } });
  const initial = await list();
  expect(initial.sessions).toHaveLength(rowCount);
  expect(initial.sessions.every((row) => row.contextTokens === 32_000)).toBe(true);
  return {
    config,
    rows,
    readCatalog,
    readPrepared,
    list,
    initial,
    refresh: () => owner.loadFullModelCatalog!({ refresh: true }),
    currentOwner: () => prepareModelRuntimeSnapshot(input),
    settleCatalog: async () => {
      await readCatalog.mock.results.at(-1)?.value;
    },
    replaceOwner: async () => {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      owner = getPreparedModelRuntimeSnapshot(input)!;
    },
  };
}

function persistProfile(profile: AuthProfileCredential) {
  const store = { version: 1, profiles: { "custom:synthetic": profile } };
  mocks.preparedAuthStore = store;
  mocks.authStorage.getAll.mockReturnValue(
    profile.type === "oauth"
      ? {
          custom: {
            type: "oauth",
            access: profile.access,
            refresh: profile.refresh,
            expires: profile.expires,
          },
        }
      : {
          custom: {
            type: "api_key",
            key: profile.type === "token" ? profile.token! : profile.key!,
          },
        },
  );
  saveAuthProfileStore(store, fixture.state.agentDir("default"));
}

beforeEach(() => {
  // Temporal presentation is separate from materialized row facts.
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
});

describe("catalog publication session rows", () => {
  it.each([false, true])(
    "keeps API facts through native observations (configured: %s)",
    async (configured) => {
      const loadModelCatalog = vi.fn<() => Promise<ModelCatalogEntry[]>>(async () => []);
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "synthetic-native",
        source: "fixture",
        harness: {
          id: "synthetic-native",
          label: "Synthetic native runtime",
          supports: () => ({ supported: true }),
          async runAttempt() {
            throw new Error("catalog-only fixture");
          },
          loadModelCatalog,
        },
      });
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.modelRegistry.getAll.mockReturnValue([model]);
      mocks.resolveNativeModelPrimary.mockReturnValue(
        configured ? "custom/synthetic-model" : undefined,
      );
      const owner = await publishPreparedModelRuntimeSnapshot(
        {
          config: configured
            ? {
                agents: { defaults: { model: "custom/synthetic-model" } },
                models: {
                  providers: {
                    custom: {
                      api: "openai-completions",
                      baseUrl: "https://synthetic.example.test/v1",
                      models: [
                        {
                          id: model.id,
                          name: model.name,
                          contextWindow: 32_000,
                          reasoning: false,
                          input: ["text"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          maxTokens: 1_000,
                        },
                      ],
                    },
                  },
                },
              }
            : {},
          agentDir: fixture.state.agentDir("default"),
        },
        { catalogMode: "static" },
      );
      const changes: (boolean | undefined)[] = [];
      const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "catalog-published") {
          changes.push(event.modelFactsChanged);
        }
      });
      try {
        expect(owner.readFullModelCatalog?.()).toBeUndefined();
        expect(owner.modelCatalog.entries).toMatchObject([model]);
        const completed = await owner.loadFullModelCatalog!({ changedOnly: true });
        expect(completed.entries).toMatchObject([model]);
        expect(owner.readFullModelCatalog?.()).toBe(completed);
        expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
        expect(changes).not.toContain(true);
        for (let observation = 0; observation < 2; observation += 1) {
          const unchanged = await owner.loadNativeModelCatalog!({
            provider: model.provider,
            modelId: model.id,
            runtime: "synthetic-native",
          });
          expect(unchanged.entries).toMatchObject([model]);
          expect(changes).not.toContain(true);
        }
        if (!configured) {
          return;
        }

        const nativeModel: ModelCatalogEntry = {
          ...model,
          contextWindow: 64_000,
          nativeRuntime: "synthetic-native",
        };
        loadModelCatalog.mockResolvedValueOnce([nativeModel]);
        const selected = await owner.loadNativeModelCatalog!({
          provider: model.provider,
          modelId: model.id,
          runtime: "synthetic-native",
        });
        expect(selected.entries).toMatchObject([nativeModel]);
        expect(selected.routeVariants.find((entry) => !entry.nativeRuntime)).toMatchObject({
          provider: model.provider,
          id: model.id,
          api: "openai-completions",
          contextWindow: 32_000,
        });
        expect(selected.routeVariants).toContainEqual(expect.objectContaining(nativeModel));
        expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
        expect(changes).toContain(true);
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["bound", "revoked"] as const)(
    "keeps session rows resident when runtime auth is %s",
    async (action) => {
      const { config, rows, list, initial, readCatalog } = await setup(true);
      const input = { config, agentId: "default", agentDir: fixture.state.agentDir("default") };
      const owner = getPreparedModelRuntimeSnapshot(input)!;
      const route = {
        agentDir: input.agentDir,
        provider: model.provider,
        modelId: model.id,
        modelApi: "openai-completions",
        modelBaseUrl: "https://synthetic.example.test/v1",
        requestTransportOverrides: "none" as const,
        authMode: "api-key",
        runtimeOwnerId: "synthetic",
      };
      if (action === "revoked") {
        expect(recordRuntimeAuthMaterialization(route)).toBe(true);
        await list();
      }
      const before = rows.materializedCount;
      const catalogReads = readCatalog.mock.calls.length;
      expect(
        action === "bound"
          ? recordRuntimeAuthMaterialization(route)
          : revokeRuntimeAuthMaterializations(route),
      ).toBe(true);
      expect(getPreparedModelRuntimeAuthMaterializations(owner)).toEqual(
        action === "bound"
          ? [expect.objectContaining({ provider: model.provider, modelId: model.id })]
          : [],
      );
      expect(rows.dirtyRowCount).toBe(0);
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount).toBe(before);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
    },
  );

  it.each(["oauth", "token"] as const)(
    "adopts current model facts after persisted %s rotation",
    async (kind) => {
      const profile: AuthProfileCredential =
        kind === "oauth"
          ? {
              type: "oauth",
              provider: "custom",
              access: "synthetic-access-before",
              refresh: "synthetic-refresh-before",
              expires: 1_900_000_000_000,
              accountId: "synthetic-account",
              email: "synthetic@example.test",
            }
          : { type: "token", provider: "custom", token: "synthetic-token-before" };
      const { rows, list, currentOwner, readCatalog, initial, settleCatalog } = await setup(
        true,
        profile,
      );
      const previousOwner = await currentOwner();
      const acquired = createDeferred();
      const reply = createDeferred<ModelCatalogSnapshot>();
      mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
        acquired.resolve();
        return reply.promise;
      });
      const rotated: AuthProfileCredential =
        profile.type === "oauth"
          ? {
              ...profile,
              access: "synthetic-access-after",
              refresh: "synthetic-refresh-after",
              expires: profile.expires + 3_600_000,
            }
          : { ...profile, token: "synthetic-token-after" };
      const publication =
        vi.fn<Parameters<typeof registerPreparedModelRuntimePublicationListener>[0]>();
      const unsubscribe = registerPreparedModelRuntimePublicationListener(publication);
      let discovery: Promise<ModelCatalogSnapshot> | undefined;
      try {
        persistProfile(rotated);
        const owner = await currentOwner();
        expect(owner).not.toBe(previousOwner);
        expect(() => previousOwner.readFullModelCatalog!()).toThrow();
        discovery = owner.loadFullModelCatalog!({ changedOnly: true });
        await acquired.promise;
        // Settle the existing unavailable/static handoff before the discovery publication.
        await settleCatalog();
        await list();
        const before = rows.materializedCount;
        const reads = readCatalog.mock.calls.length;
        reply.resolve(catalog(kind === "token" ? { ...model, contextWindow: 64_000 } : model));
        const discovered = await discovery;
        expect(
          getPreparedModelFullCatalogAuth(discovered)?.authStore.profiles["custom:synthetic"],
        ).toEqual(rotated);
        await settleCatalog();
        const result = await list();
        expect(rows.dirtyRowCount).toBe(0);
        expect(readCatalog.mock.calls.length).toBeGreaterThan(reads);
        expect(publication).toHaveBeenCalledWith({
          phase: "catalog-published",
          modelFactsChanged: true,
          refreshStatusChanged: true,
        });
        if (kind === "oauth") {
          expect(result.sessions).toEqual(initial.sessions);
          expect(rows.materializedCount).toBe(before);
        } else {
          expect(result.sessions.every((row) => row.contextTokens === 64_000)).toBe(true);
          expect(rows.materializedCount - before).toBe(rowCount);
        }
      } finally {
        reply.resolve(catalog());
        await discovery;
        unsubscribe();
      }
    },
  );

  it("publishes settled attempt status without rebuilding unchanged resident rows", async () => {
    const { rows, list, refresh, initial, readCatalog } = await setup();

    const before = rows.materializedCount;
    const catalogReads = readCatalog.mock.calls.length;
    const started = createDeferred();
    const reply = createDeferred<ModelCatalogSnapshot>();
    const events = vi.fn<Parameters<typeof registerPreparedModelRuntimePublicationListener>[0]>();
    const unsubscribe = registerPreparedModelRuntimePublicationListener(events);
    mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
      started.resolve();
      return reply.promise;
    });
    const pending = refresh();
    try {
      await started.promise;
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      expect(rows.dirtyRowCount).toBe(0);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
      reply.resolve(catalog());
      await pending;
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      expect(rows.dirtyRowCount).toBe(0);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);

      mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(new Error("synthetic failure"));
      await expect(refresh()).rejects.toThrow("synthetic failure");
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      await refresh();
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      expect(rows.dirtyRowCount).toBe(0);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
      expect(events.mock.calls.map(([event]) => event)).toEqual([
        { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
        {
          phase: "catalog-failed",
          error: expect.objectContaining({ message: "synthetic failure" }),
          modelFactsChanged: false,
        },
        { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
      ]);
    } finally {
      reply.resolve(catalog());
      await pending;
      unsubscribe();
    }
  });

  it("refreshes changed model facts, removal, owner replacement, and config", async () => {
    const { rows, list, refresh, replaceOwner, config, settleCatalog } = await setup(true);
    let previousCount = rows.materializedCount;
    const currentModel = { ...model };
    // Each independent metadata change must invalidate, including non-context capabilities.
    for (const patch of [
      { contextWindow: 64_000 },
      { reasoning: true },
      { input: ["text", "image"] },
    ] satisfies Partial<ModelCatalogEntry>[]) {
      Object.assign(currentModel, patch);
      mocks.runPreparedModelCatalogWorker.mockResolvedValue(catalog(currentModel));
      await refresh();
      await settleCatalog();
      const changed = await list();
      expect(changed.sessions).toHaveLength(rowCount);
      expect(changed.sessions.every((row) => row.contextTokens === 64_000)).toBe(true);
      expect(
        changed.sessions.every((row) =>
          currentModel.reasoning
            ? row.thinkingLevels!.some((level) => level.id === "high")
            : row.thinkingLevels!.every((level) => level.id === "off" || level.id === "ultra"),
        ),
      ).toBe(true);
      expect(rows.materializedCount - previousCount).toBe(rowCount);
      previousCount = rows.materializedCount;
    }

    const routed = catalog(currentModel);
    routed.routeVariants = [{ ...currentModel, contextTokens: 48_000, reasoning: false }];
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(routed);
    await refresh();
    await settleCatalog();
    const rerouted = await list();
    expect(rerouted.sessions.every((row) => row.contextTokens === 48_000)).toBe(true);
    expect(
      rerouted.sessions.every((row) =>
        row.thinkingLevels!.every((level) => level.id === "off" || level.id === "ultra"),
      ),
    ).toBe(true);
    expect(rows.materializedCount - previousCount).toBe(rowCount);

    // An empty successful inventory is a real removal, including its dynamic context limit.
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries: [], routeVariants: [] });
    await refresh();
    await settleCatalog();
    expect((await list()).sessions.every((row) => row.contextTokens !== 64_000)).toBe(true);
    const removed = rows.materializedCount;
    await replaceOwner();
    await settleCatalog();
    await list();
    expect(rows.materializedCount - removed).toBeGreaterThanOrEqual(rowCount);
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(catalog(model));
    await refresh();
    await settleCatalog();
    expect((await list()).sessions.every((row) => row.contextTokens === 32_000)).toBe(true);
    const replaced = rows.materializedCount;
    config.models = {
      providers: {
        custom: {
          baseUrl: "https://synthetic.example.test/v1",
          models: [
            {
              id: model.id,
              name: model.name,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1_000,
              contextWindow: 12_000,
              contextTokens: 12_000,
            },
          ],
        },
      },
    };
    sessionChanges.emit({ all: true, scope: "config" });
    expect((await list()).sessions.every((row) => row.contextTokens === 12_000)).toBe(true);
    expect(rows.materializedCount - replaced).toBe(rowCount);
  });

  it.each(["unchanged", "changed", "failed"] as const)(
    "converges when a %s publication arrives during a yielded drain",
    async (outcome) => {
      let publishedDuringDrain = false;
      let publication: Promise<void> | undefined;
      let afterRefresh: (() => void) | undefined;
      const createDrain = projectionWork.createSessionProjectionDrain;
      const drains = vi
        .spyOn(projectionWork, "createSessionProjectionDrain")
        .mockImplementation((params) =>
          createDrain({
            ...params,
            async refresh() {
              if (publication) {
                expect(publishedDuringDrain).toBe(true);
                await publication;
              }
              await params.refresh();
              afterRefresh?.();
            },
          }),
        );
      try {
        const { rows, list, refresh } = await setup();
        const before = rows.materializedCount;
        const publish = async () => {
          publishedDuringDrain = rows.materializedCount > before && rows.dirtyRowCount > 0;
          if (outcome === "changed") {
            mocks.runPreparedModelCatalogWorker.mockResolvedValue(
              catalog({ ...model, contextWindow: 64_000 }),
            );
          } else if (outcome === "failed") {
            mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(new Error("drain failure"));
          }
          if (outcome === "failed") {
            await expect(refresh()).rejects.toThrow("drain failure");
          } else {
            await refresh();
          }
        };
        afterRefresh = () => {
          if (publication || rows.materializedCount === before || rows.dirtyRowCount === 0) {
            return;
          }
          publication = new Promise<void>((resolve, reject) => {
            setImmediate(() => {
              void publish().then(resolve, reject);
            });
          });
          // The next batch joins this result after the real event-loop turn.
          void publication.catch(() => {});
        };
        sessionChanges.emit({ all: true, scope: "config" });
        const result = await list();
        expect(publishedDuringDrain).toBe(true);
        expect(result.sessions).toHaveLength(rowCount);
        expect(
          result.sessions.every(
            (row) => row.contextTokens === (outcome === "changed" ? 64_000 : 32_000),
          ),
        ).toBe(true);
        expect(rows.dirtyRowCount).toBe(0);
        if (outcome !== "changed") {
          expect(rows.materializedCount - before).toBe(rowCount);
        }
      } finally {
        afterRefresh = undefined;
        try {
          await publication;
        } finally {
          drains.mockRestore();
        }
      }
    },
  );

  it("recovers an incomplete optional catalog after an identical successful publication", async () => {
    const { rows, list, refresh, readPrepared } = await setup(true);
    const readPublished = readPrepared.getMockImplementation()!;
    readPrepared.mockRejectedValue(new Error("optional prepared reader unavailable"));
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(
      catalog({ ...model, contextWindow: 64_000 }),
    );
    await refresh();
    const fallback = await list();
    expect(fallback.sessions).toHaveLength(rowCount);
    expect(fallback.sessions.every((row) => row.contextTokens !== 64_000)).toBe(true);
    expect(rows.needsMaterialization).toBe(false);
    readPrepared.mockImplementation(readPublished);
    await refresh();
    expect((await list()).sessions.every((row) => row.contextTokens === 64_000)).toBe(true);
    expect(rows.needsMaterialization).toBe(false);
  });

  it("serves retained rows after a failed background catalog read and retries on the next list", async () => {
    const { rows, list, refresh, readCatalog } = await setup();
    const replacement = createDeferred<Awaited<ReturnType<typeof readCatalog>>>();
    readCatalog.mockReturnValueOnce(replacement.promise);
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(
      catalog({ ...model, contextWindow: 64_000 }),
    );
    await refresh();
    try {
      expect((await list()).sessions.every((row) => row.contextTokens === 32_000)).toBe(true);
      replacement.reject(new Error("projection read failure"));
      await projectionWork.yieldSessionListWork();
      expect(rows.needsMaterialization).toBe(false);
      expect((await list()).sessions.every((row) => row.contextTokens === 64_000)).toBe(true);
      expect(rows.needsMaterialization).toBe(false);
    } finally {
      replacement.resolve([]);
    }
  });
});
