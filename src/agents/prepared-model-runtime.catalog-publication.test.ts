// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { readPreparedServerMethodModelCatalogs } from "../gateway/server-methods/optional-model-catalog.js";
import { sessionCreateHandlers } from "../gateway/server-methods/sessions-create.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "../gateway/server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient, RespondFn } from "../gateway/server-methods/types.js";
import { readPreparedGatewayModelCatalog } from "../gateway/server-model-catalog.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../gateway/session-row-projection.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
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
  markPreparedModelRuntimeSnapshotsStale,
  publishPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "catalog-publication-rows", scenario: "minimal" },
  () => {
    vi.useRealTimers();
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

function baseConfig(): OpenClawConfig {
  return { agents: { entries: { default: {} }, defaults: { model: "custom/synthetic-model" } } };
}

function providerConfig(maxTokens: number, api?: "openai-completions") {
  return {
    models: {
      providers: {
        custom: {
          ...(api ? { api } : {}),
          baseUrl: "https://synthetic.example.test/v1",
          models: [
            {
              id: model.id,
              name: model.name,
              reasoning: false,
              input: ["text" as const],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens,
            },
          ],
        },
      },
    },
  };
}

function publish(config: OpenClawConfig) {
  return refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
}

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
  const config = baseConfig();
  mocks.configuredAgentIds = ["default"];
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => catalog());
  const input = { config, agentId: "default", agentDir: fixture.state.agentDir("default") };
  if (profile) {
    mocks.usePersistedAuthProfiles = true;
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());
    persistProfile(profile);
    await publish(config);
  }
  const owner = profile
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
  it.each([
    { selection: "explicit", superseded: false, stop: undefined },
    { selection: "configured", superseded: false, stop: undefined },
    { selection: "explicit", superseded: true, stop: undefined },
    { selection: "explicit", superseded: false, stop: "deadline" },
    { selection: "explicit", superseded: false, stop: "connection" },
  ])(
    "creates only with current native activation ($selection, superseded=$superseded, stop=$stop)",
    async ({ selection, superseded, stop }) => {
      const initial = baseConfig();
      mocks.configuredAgentIds = ["default"];
      await publish(initial);
      const previous = getPreparedModelRuntimeSnapshot(fixture.agentInput("default", initial))!;
      const config: OpenClawConfig = {
        ...initial,
        plugins: { entries: { "synthetic-native": { enabled: true } } },
        ...providerConfig(4_096),
        agents: {
          ...initial.agents,
          defaults: {
            ...initial.agents?.defaults,
            models: { "custom/synthetic-model": { agentRuntime: { id: "synthetic-native" } } },
          },
        },
      };
      let ready = false;
      const nativeEntered = createDeferred();
      const nativeRelease = createDeferred();
      const loadNative = vi.fn(async () => {
        nativeEntered.resolve();
        if (stop) {
          await nativeRelease.promise;
        }
        ready = true;
        if (superseded) {
          markPreparedModelRuntimeSnapshotsStale();
        }
        return [{ ...model, nativeRuntime: "synthetic-native" }];
      });
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "synthetic-native",
        source: "fixture",
        harness: {
          id: "synthetic-native",
          label: "Synthetic native runtime",
          authBootstrap: "harness",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          loadModelCatalog: loadNative,
          readModelCatalogReadiness: () => (ready ? { accountType: "apiKey" } : undefined),
        },
      });
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.modelRegistry.fork.mockImplementation((authStorage) => ({
        ...mocks.modelRegistry,
        authStorage,
      }));
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.resolveNativeModelPrimary.mockReturnValue("custom/synthetic-model");
      await fixture.state.writeConfig(config);
      await publish(config);
      expect(previous.isCurrent()).toBe(false);
      expect(loadNative).not.toHaveBeenCalled();
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      context.readPreparedGatewayModelCatalog = () =>
        readPreparedGatewayModelCatalog({ agentId: "default", getConfig: () => config });
      const connection = new AbortController();
      const client: GatewayClient = {
        connectionSignal: connection.signal,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes: ["operator.admin"],
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "synthetic-native",
            activation: { onAgentHarnesses: ["synthetic-native"] },
          },
        ],
      });
      const create = sessionCreateHandlers["sessions.create"]!;
      for (let index = 0; index < (superseded || stop ? 1 : 2); index++) {
        const key = `agent:default:dashboard:native-activation-${selection}-${index}`;
        const respond = vi.fn<RespondFn>();
        if (stop) {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        }
        const creation = withPluginRuntimeGenerationScope(
          { pluginRegistry: registry, metadataSnapshot },
          () =>
            create({
              req: { type: "req", id: key, method: "sessions.create" },
              params: {
                key,
                agentId: "default",
                model: "custom/synthetic-model",
                ...(selection === "explicit" ? { agentRuntime: "synthetic-native" } : {}),
              },
              client,
              context,
              respond,
              isWebchatConnect: () => true,
            }),
        );
        if (stop) {
          try {
            await nativeEntered.promise;
            if (stop === "deadline") {
              await vi.advanceTimersByTimeAsync(20_000);
            } else {
              connection.abort();
            }
            await creation;
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
            );
          } finally {
            nativeRelease.resolve();
            vi.useRealTimers();
          }
          await loadNative.mock.results[0]?.value;
        } else if (superseded) {
          await expect(creation).rejects.toThrow(
            "prepared model runtime publication was superseded",
          );
        } else {
          await creation;
          expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0]?.[2])).toBe(true);
        }
        const entry = loadSessionEntry({ agentId: "default", sessionKey: key });
        if (superseded || stop) {
          expect(entry).toBeUndefined();
        } else {
          expect(entry).toMatchObject({ agentRuntimeOverride: "synthetic-native" });
        }
      }
      expect(loadNative).toHaveBeenCalledOnce();
    },
  );

  it("keeps configured API facts through native observations", async () => {
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
    mocks.resolveNativeModelPrimary.mockReturnValue("custom/synthetic-model");
    const owner = await publishPreparedModelRuntimeSnapshot(
      {
        config: {
          agents: { defaults: { model: "custom/synthetic-model" } },
          ...providerConfig(1_000, "openai-completions"),
        },
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
      // Without provider inventory, a changed-only pass acquires the full catalog.
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledExactlyOnceWith(undefined);
      changes.length = 0;
      for (let observation = 0; observation < 2; observation += 1) {
        const unchanged = await owner.loadNativeModelCatalog!({
          provider: model.provider,
          modelId: model.id,
          runtime: "synthetic-native",
        });
        expect(unchanged.entries).toMatchObject([model]);
        expect(changes).not.toContain(true);
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
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
      expect(changes).toContain(true);
    } finally {
      unsubscribe();
    }
  });

  it("keeps session rows resident through runtime auth binding and revocation", async () => {
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
    const before = rows.materializedCount;
    const catalogReads = readCatalog.mock.calls.length;
    for (const action of [recordRuntimeAuthMaterialization, revokeRuntimeAuthMaterializations]) {
      expect(action(route)).toBe(true);
      expect(getPreparedModelRuntimeAuthMaterializations(owner)).toEqual(
        action === recordRuntimeAuthMaterialization
          ? [expect.objectContaining({ provider: model.provider, modelId: model.id })]
          : [],
      );
      expect(rows.dirtyRowCount).toBe(0);
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount).toBe(before);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
    }
  });

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
    const expectResident = async () => {
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
    };
    const expectUnchanged = async () => {
      await expectResident();
      expect(rows.dirtyRowCount).toBe(0);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
    };
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
      await expectUnchanged();
      reply.resolve(catalog());
      await pending;
      await expectUnchanged();

      mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(new Error("synthetic failure"));
      await expect(refresh()).rejects.toThrow("synthetic failure");
      await expectResident();
      await refresh();
      await expectUnchanged();
      expect(events.mock.calls.map(([event]) => event)).toEqual([
        { phase: "catalog-status", modelFactsChanged: false },
        { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
        { phase: "catalog-status", modelFactsChanged: false },
        {
          phase: "catalog-failed",
          modelFactsChanged: false,
        },
        { phase: "catalog-status", modelFactsChanged: false },
        { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
      ]);
    } finally {
      reply.resolve(catalog());
      await pending;
      unsubscribe();
    }
  });

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
});
