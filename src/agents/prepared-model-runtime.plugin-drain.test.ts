// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { adoptRuntimeContextEngineRegistrations } from "../context-engine/registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { adoptRuntimeToolRegistrations } from "../plugins/tool-registry-adoption.js";
import { runContextEngineMaintenanceWork } from "./embedded-agent-runner/context-engine-maintenance-work.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import { loadProviderScopedThinkingCatalog } from "./prepared-model-catalog.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePreparedModelRuntimeSnapshot,
  acquirePublishedPreparedModelRuntime,
  beginPreparedModelRuntimePluginDrain,
  loadPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeInput,
} from "./prepared-model-runtime.js";
import { ownPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-runtime-plugin-drain" });

it.each([
  {
    name: "model acquisition",
    acquire: async (input: PreparedModelRuntimeInput) => {
      await using lease = await acquireAgentRunPreparedModelRuntime(input);
      return lease.snapshot.config;
    },
  },
  {
    name: "channel reply dispatch",
    acquire: async (_input: PreparedModelRuntimeInput) =>
      (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))?.config,
  },
])("lets unrelated admitted $name wait for a plugin drain", async ({ acquire }) => {
  const config = {};
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
  const input = fixture.agentInput("default", config);
  const unrelated = new PluginInstance("unrelated-channel");
  const donor = new PluginInstance("reloading-donor");
  const releaseReplacement = donor.reserveReplacement();
  const drain = beginPreparedModelRuntimePluginDrain();
  let settled = false;
  const acquisition = unrelated
    .run(() => acquire(input))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    const metadata = await prepareModelRuntimeSnapshot(input, { readPublished: true });
    expect(metadata.config).toBe(config);
    expect(settled).toBe(false);
    drain.release();
    expect(await acquisition).toEqual({ value: config });
  } finally {
    drain.release();
    releaseReplacement();
    await acquisition;
    await Promise.all([unrelated.dispose(), donor.dispose()]);
  }
});

it.each([false, true])(
  "settles a reserved instance's admitted call before call-inclusive drainage (nested: %s)",
  async (nested) => {
    const config = {};
    fixture.mocks.authStorage.getAll.mockReturnValue({});
    fixture.mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const input = fixture.agentInput("default", config);
    const instance = new PluginInstance("reserved-call");
    const callee = new PluginInstance("unrelated-callee");
    const abort = new AbortController();
    const start = createDeferred();
    const admitted = instance
      .run(async () => {
        await start.promise;
        const acquire = async () => {
          await using lease = await acquireAgentRunPreparedModelRuntime(input, {
            abortSignal: abort.signal,
          });
          return lease.snapshot;
        };
        return await (nested ? callee.run(acquire) : acquire());
      })
      .catch((error: unknown) => error);
    const releaseReplacement = instance.reserveReplacement();
    const drain = beginPreparedModelRuntimePluginDrain();
    try {
      start.resolve();
      await prepareModelRuntimeSnapshot(input, { readPublished: true });
      abort.abort(new Error("Acquisition incorrectly waited on its own drain"));
      expect(await admitted).toMatchObject({ admissionBlocked: true });
      await instance.waitForRetainedWork(new AbortController().signal, { includeCalls: true });
    } finally {
      drain.release();
      releaseReplacement();
      start.resolve();
      await admitted;
      await Promise.all([instance.dispose(), callee.dispose()]);
    }
  },
);

it("refuses live turn-lease custody but lets a detached generation reader wait", async () => {
  const config = {};
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: "lease-donor", source: "/synthetic/lease-donor.ts" });
  builder.registry.plugins.push(record);
  builder.createApi(record, { config });
  const donor = getPluginInstance(record)!;
  markPluginRegistryActive(builder.registry);
  fixture.mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(builder.registry);
  const input = { ...fixture.agentInput("default", config), loadRuntimePlugins: true };
  await using turn = await acquireAgentRunPreparedModelRuntime(input);
  expect(turn.snapshot.pluginRegistry).toBe(builder.registry);
  expect(donor.retainedWorkCount).toBeGreaterThan(0);
  const unrelated = new PluginInstance("turn-tool");
  const releaseReplacement = donor.reserveReplacement();
  const drain = beginPreparedModelRuntimePluginDrain();
  let active = true;
  const context = unrelated.run(() =>
    withPreparedModelRuntimePluginGenerationScope(
      turn.pluginGeneration,
      () => AsyncLocalStorage.snapshot(),
      () => (active ? turn.snapshot : undefined),
    ),
  );
  const acquire = async () => {
    await using lease = await acquireAgentRunPreparedModelRuntime(input);
    return lease.snapshot.config;
  };
  try {
    const result = await context(acquire).catch((error: unknown) => error);
    expect(result).toMatchObject({ admissionBlocked: true });
    active = false;
    let settled = false;
    const detached = context(acquire).finally(() => {
      settled = true;
    });
    await prepareModelRuntimeSnapshot(fixture.agentInput("default", config), {
      readPublished: true,
    });
    expect(settled).toBe(false);
    releaseReplacement();
    drain.release();
    expect(await detached).toBe(config);
  } finally {
    active = false;
    releaseReplacement();
    drain.release();
    await turn[Symbol.asyncDispose]();
    await Promise.all([unrelated.dispose(), donor.dispose()]);
  }
});

it.each([
  { gate: "replacement", quiesced: false },
  { gate: "replacement", quiesced: true },
  { gate: "drain", quiesced: false },
  { gate: "drain", quiesced: true },
])(
  "settles maintenance model acquisition on $gate so donor replacement can drain (quiesced=$quiesced)",
  async ({ gate, quiesced }) => {
    const config = {
      plugins: { allow: ["fixture", "knowledge"], slots: { contextEngine: "fixture" } },
    };
    const replacementConfig = { ...config, agents: { defaults: { workspace: "/synthetic/new" } } };
    fixture.mocks.authStorage.getAll.mockReturnValue({});
    fixture.mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const input = { ...fixture.agentInput("default", config), loadRuntimePlugins: true };
    const abort = new AbortController();
    const createRegistry = (runtime: boolean) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "fixture",
        source: "/synthetic/fixture.ts",
        enabled: true,
      });
      const toolRecord = createPluginRecord({
        id: "knowledge",
        source: "/synthetic/knowledge.ts",
        enabled: true,
        contracts: { tools: ["fixture_tool"] },
      });
      builder.registry.plugins.push(record, toolRecord);
      const api = builder.createApi(record, { config });
      builder.createApi(toolRecord, { config }).registerTool(() => null, { name: "fixture_tool" });
      if (runtime) {
        api.registerContextEngine("fixture", () => ({
          info: { id: "fixture", name: "Fixture" },
          async ingest() {
            return { ingested: false };
          },
          async assemble({ messages }) {
            return { messages, estimatedTokens: 0 };
          },
          async compact() {
            return { ok: true, compacted: false };
          },
          async maintain() {
            // Match runtime.llm.complete's executable lease request, without provider I/O.
            const acquisition = acquireAgentRunPreparedModelRuntime(input, {
              abortSignal: abort.signal,
              catalogMode: "static",
            });
            // A deterministic escape distinguishes a gate wait from immediate rejection.
            abort.abort(new Error("acquisition reached the replacement wait"));
            const lease = await acquisition;
            await lease[Symbol.asyncDispose]();
            return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
          },
        }));
        markPluginRegistryActive(builder.registry);
        setPluginRuntimeLoadContext(builder.registry, {
          rawConfig: config,
          config,
          activationSourceConfig: config,
          autoEnabledReasons: {},
          workspaceDir: "/synthetic",
          env: process.env,
          logger: { info() {}, warn() {}, error() {} },
        });
      }
      return {
        registry: builder.registry,
        instance: getPluginInstance(record)!,
        toolInstance: getPluginInstance(toolRecord)!,
      };
    };
    const donor = createRegistry(true);
    const local = createRegistry(false);
    const registry = adoptRuntimeContextEngineRegistrations(
      adoptRuntimeToolRegistrations(local.registry, donor.registry, config),
      donor.registry,
    );
    expect(registry.tools[0]!.factory).toBe(donor.registry.tools[0]!.factory);
    const lifetime = ownPreparedPluginGeneration({
      pluginRegistry: registry,
      pluginMetadataSnapshot: createPluginMetadataSnapshot({ manifestRegistry: makeRegistry([]) }),
      remoteCatalog: null,
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    });
    const releaseRun = lifetime.retain(true);
    let lease: Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>> | undefined;
    let releaseReplacement: (() => void) | undefined;
    let drain: ReturnType<typeof beginPreparedModelRuntimePluginDrain> | undefined;
    try {
      lease = await withPluginRuntimeRegistryScope(registry, () =>
        createContextEngineLogicalTurnLease({
          identity: { runId: "plugin-drain", sessionId: "fixture" },
          config,
        }),
      );
      lease.begin();
      await lease.engine.assemble({ sessionId: "fixture", messages: [] });
      expect(donor.toolInstance.retainedWorkCount).toBeGreaterThan(0);

      // An expired invocation frame must not confer admission on a new reader.
      const expiredInvocation = donor.toolInstance.run(() => AsyncLocalStorage.snapshot());
      if (gate === "drain") {
        drain = beginPreparedModelRuntimePluginDrain();
      } else {
        markPreparedModelRuntimeSnapshotsStale("donor plugin replacement", {
          waitForReplacement: true,
        });
      }
      const reader = expiredInvocation(() => acquireAgentRunPreparedModelRuntime(input));
      releaseReplacement = donor.toolInstance.reserveReplacement();
      if (quiesced) {
        donor.toolInstance.quiesce();
      }
      const replacement = donor.toolInstance
        .waitForRetainedWork(new AbortController().signal, { includeConsumers: true })
        .then(() => {
          drain?.release();
          return refreshPreparedModelRuntimeSnapshots(replacementConfig);
        });
      const maintenance = runContextEngineMaintenanceWork(async () => {
        await lease!.engine.maintain?.({
          sessionId: "fixture",
          sessionFile: "/synthetic/session.jsonl",
        });
      }, new AbortController().signal);
      const result = maintenance.catch((error: unknown) => error);
      lease.deferDisposalUntil(maintenance);
      const error = await result;
      await lease.dispose();
      await releaseRun();
      expect(donor.toolInstance.retainedWorkCount).toBe(0);
      await replacement;
      await using newReader = await reader;
      expect(newReader.snapshot.config).toBe(replacementConfig);
      expect(error).toMatchObject({
        message:
          "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
      });
    } finally {
      abort.abort();
      drain?.release();
      releaseReplacement?.();
      await lease?.dispose();
      await releaseRun();
      await donor.instance.dispose();
      await donor.toolInstance.dispose();
    }
  },
);

const ownerAcquisitions = [
  {
    name: "loaded snapshot",
    acquire: async (input: PreparedModelRuntimeInput) =>
      (await loadPreparedModelRuntimeSnapshot(input)).config,
  },
  {
    name: "published lease",
    acquire: async (input: PreparedModelRuntimeInput) => {
      await using lease = await acquirePublishedPreparedModelRuntime(input);
      return lease.snapshot.config;
    },
  },
  {
    name: "retained snapshot",
    acquire: async (input: PreparedModelRuntimeInput) => {
      await using lease = await acquirePreparedModelRuntimeSnapshot(input);
      return lease.snapshot.config;
    },
  },
  {
    name: "prepared snapshot",
    acquire: async (input: PreparedModelRuntimeInput) =>
      (await prepareModelRuntimeSnapshot(input)).config,
  },
  {
    name: "reply dispatch",
    acquire: async (_input: PreparedModelRuntimeInput) =>
      (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))?.config,
  },
];

it.each(ownerAcquisitions)(
  "refuses admitted $name acquisition during drain while unadmitted readers wait",
  async ({ acquire }) => {
    const config = {};
    fixture.mocks.authStorage.getAll.mockReturnValue({});
    fixture.mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const input = fixture.agentInput("default", config);
    const instance = new PluginInstance("fixture");
    const consumer = instance.retainConsumer();
    const releaseReplacement = instance.reserveReplacement();
    instance.quiesce();
    const drain = beginPreparedModelRuntimePluginDrain();
    let readerSettled = false;
    const reader = acquire(input).finally(() => {
      readerSettled = true;
    });
    try {
      // Passive metadata keeps serving the live publication without taking execution admission.
      const metadata = await consumer.run(() =>
        prepareModelRuntimeSnapshot(input, { readPublished: true }),
      );
      expect(metadata.config).toBe(config);
      expect(readerSettled).toBe(false);
      const admitted = consumer.run(() => acquire(input));
      const result = admitted.catch((error: unknown) => error);
      // Release is the deterministic escape on the baseline, not the intended admission path.
      drain.release();
      const error = await result;
      expect(error).toBeInstanceOf(PreparedModelRuntimeOwnerNotPublishedError);
      expect(error).toMatchObject({
        message:
          "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
      });
    } finally {
      consumer.release();
      releaseReplacement();
      drain.release();
      await instance.waitForRetainedWork(new AbortController().signal, { includeConsumers: true });
      await expect(reader).resolves.toBe(config);
      expect(readerSettled).toBe(true);
      await instance.dispose();
    }
  },
);

it("refuses an admitted passive read waiting on auth publication behind the drain", async () => {
  const config = {};
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
  const input = fixture.agentInput("default", config);
  const original = await prepareModelRuntimeSnapshot(input);
  const instance = new PluginInstance("fixture");
  const consumer = instance.retainConsumer();
  const releaseReplacement = instance.reserveReplacement();
  const drain = beginPreparedModelRuntimePluginDrain();
  try {
    fixture.mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
    expect(original.isCurrent()).toBe(false);
    const reader = prepareModelRuntimeSnapshot(input, { readPublished: true });
    const admitted = consumer.run(() =>
      prepareModelRuntimeSnapshot(input, { readPublished: true }),
    );
    const result = admitted.catch((error: unknown) => error);
    drain.release();
    const error = await result;
    expect(error).toBeInstanceOf(PreparedModelRuntimeOwnerNotPublishedError);
    expect(error).toMatchObject({
      message:
        "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
    });
    expect((await reader).isCurrent()).toBe(true);
  } finally {
    consumer.release();
    releaseReplacement();
    drain.release();
    await instance.dispose();
  }
});

it("lets admitted plugin work join initial model-owner construction", async () => {
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  const input = fixture.agentInput("default", {});
  const started = createDeferred();
  const finish = createDeferred();
  fixture.mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    return { entries: [] };
  });
  const instance = new PluginInstance("fixture");
  const first = acquireAgentRunPreparedModelRuntime(input);
  await started.promise;
  const admitted = instance.run(() => acquireAgentRunPreparedModelRuntime(input));
  try {
    finish.resolve();
    await using firstLease = await first;
    await using admittedLease = await admitted;
    expect(admittedLease.snapshot.pluginRegistry).toBe(firstLease.snapshot.pluginRegistry);
  } finally {
    finish.resolve();
    await instance.dispose();
  }
});

it("propagates admitted thinking-catalog acquisition refusal through unpublished-owner fallback", async () => {
  const config = {};
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
  const input = fixture.agentInput("default", config);
  const instance = new PluginInstance("fixture");
  const consumer = instance.retainConsumer();
  const releaseReplacement = instance.reserveReplacement();
  const drain = beginPreparedModelRuntimePluginDrain();
  try {
    const acquisition = consumer.run(() =>
      loadProviderScopedThinkingCatalog({
        config,
        agentId: "default",
        agentDir: input.agentDir,
        provider: "fixture",
        model: "fixture",
      }),
    );
    const result = acquisition.catch((error: unknown) => error);
    drain.release();
    expect(await result).toMatchObject({
      message:
        "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
    });
  } finally {
    consumer.release();
    releaseReplacement();
    drain.release();
    await instance.dispose();
  }
});

it("refuses admitted auth republication waits after an initial owner is invalidated", async () => {
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  const input = {
    ...fixture.agentInput("default", {}),
    inheritedAuthDir: "/synthetic/previous-auth",
  };
  const started = createDeferred();
  const finish = createDeferred();
  fixture.mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    return { entries: [] };
  });
  const instance = new PluginInstance("fixture");
  const consumer = instance.retainConsumer();
  const releaseReplacement = instance.reserveReplacement();
  const first = publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" }).catch(
    (error: unknown) => error,
  );
  await started.promise;
  const drain = beginPreparedModelRuntimePluginDrain();
  try {
    fixture.mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
    const acquisition = consumer.run(() =>
      prepareModelRuntimeSnapshot(input, { readPublished: true }),
    );
    const result = acquisition.catch((error: unknown) => error);
    finish.resolve();
    drain.release();
    expect(await result).toMatchObject({
      message:
        "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
    });
  } finally {
    finish.resolve();
    drain.release();
    consumer.release();
    releaseReplacement();
    await first;
    await instance.dispose();
  }
});
