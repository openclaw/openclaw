// Verifies prepared agent turns retain their selected runtime context-engine owner.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { resetContextEngineRuntimeQuarantineForTests } from "../context-engine/registry.test-support.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { loadAndActivateRootPluginRegistry, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";
import { getSandboxBackendFactory } from "./sandbox/backend.js";

const SANDBOX_PROBE_ID = "scoped-load-probe";
afterEach(async () => {
  await clearActivePluginRegistry();
  resetContextEngineRuntimeQuarantineForTests();
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

it("keeps the configured context engine active in a prepared agent registry", async () => {
  useNoBundledPlugins();
  const engineId = "prepared-context-engine";
  const plugin = writePlugin({
    id: engineId,
    body: `module.exports = {
      id: ${JSON.stringify(engineId)},
      register(api) {
        api.registerContextEngine(${JSON.stringify(engineId)}, () => ({
          info: { id: ${JSON.stringify(engineId)}, name: "Prepared Context Engine" },
          async ingest() { return { ingested: false }; },
          async assemble({ messages }) {
            return { messages, estimatedTokens: 0, systemPromptAddition: "prepared-engine" };
          },
          async compact() { return { ok: true, compacted: false }; },
        }));
      },
    };\n`,
  });
  const config = {
    plugins: {
      load: { paths: [plugin.file] },
      slots: { contextEngine: engineId },
    },
  };

  const activeRegistry = loadAndActivateRootPluginRegistry({
    cache: false,
    config,
    workspaceDir: makePluginLoaderTempDir(),
    onlyPluginIds: [engineId],
  });
  const preparedRegistry = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [],
    config,
    workspaceDir: plugin.dir,
  });

  expect(preparedRegistry).not.toBe(activeRegistry);
  await withPluginRuntimeRegistryScope(preparedRegistry, async () => {
    const lease = await createContextEngineLogicalTurnLease({
      identity: { runId: "test-run", sessionId: "test-session" },
      config,
      workspaceDir: plugin.dir,
    });
    expect(lease.degraded).toBe(false);
    expect(lease.effectiveEngineId).toBe(engineId);
    expect(lease.effectiveEnginePluginId).toBe(engineId);
    await expect(
      lease.begin().engine.assemble({ messages: [], sessionId: "prepared-session" }),
    ).resolves.toMatchObject({ systemPromptAddition: "prepared-engine" });
    await lease.dispose();
  });
});

it("selects a full-mode-only context engine on caller-owned handles without full-only global setup", async () => {
  useNoBundledPlugins();
  const previousSandboxFactory = getSandboxBackendFactory(SANDBOX_PROBE_ID);
  const contextEngine = writePlugin({
    id: "ce-probe",
    body: `module.exports = {
  id: "ce-probe",
  register(api) {
    if (api.registrationMode === "full") {
      api.registerContextEngine("ce-probe", async () => ({
        info: { id: "ce-probe", name: "CE Probe" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        dispose: async () => {},
      }));
    }
  },
};`,
  });
  const sandboxProbe = writePlugin({
    id: "sandbox-probe",
    body: `module.exports = {
  id: "sandbox-probe",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const { registerSandboxBackend } = require("openclaw/plugin-sdk/sandbox");
    api.lifecycle.onDispose(registerSandboxBackend(${JSON.stringify(SANDBOX_PROBE_ID)}, async () => {
      throw new Error("sandbox probe backend should not run");
    }));
  },
};`,
  });
  const config = {
    plugins: {
      load: { paths: [contextEngine.dir, sandboxProbe.dir] },
      allow: ["ce-probe", "sandbox-probe"],
      slots: { contextEngine: "ce-probe" },
      entries: {
        "ce-probe": { enabled: true },
        "sandbox-probe": { enabled: true },
      },
    },
  };
  const workspaceDir = makePluginLoaderTempDir();
  const root = loadAndActivateRootPluginRegistry({
    cache: false,
    config,
    onlyPluginIds: ["ce-probe", "sandbox-probe"],
  });
  const rootSandboxFactory = getSandboxBackendFactory(SANDBOX_PROBE_ID);

  expect(getActivePluginRegistry()).toBe(root);
  expect(root.plugins, JSON.stringify(root.diagnostics)).toEqual([
    expect.objectContaining({ id: "ce-probe", status: "loaded" }),
    expect.objectContaining({ id: "sandbox-probe", status: "loaded" }),
  ]);
  expect(root.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");
  expect(rootSandboxFactory).not.toBeNull();
  expect(rootSandboxFactory).not.toBe(previousSandboxFactory);

  const handle = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: ["ce-probe", "sandbox-probe"],
    config,
    workspaceDir,
  });
  const discovery = loadPluginRegistryHandle({
    cache: false,
    config,
    onlyPluginIds: ["ce-probe", "sandbox-probe"],
  });

  expect(handle).not.toBe(root);
  expect(getActivePluginRegistry()).toBe(root);
  expect(handle.plugins.find((plugin) => plugin.id === "sandbox-probe")?.status).toBe("loaded");
  expect(getSandboxBackendFactory(SANDBOX_PROBE_ID)).toBe(rootSandboxFactory);
  expect(discovery.contextEngines.get("ce-probe")).toBeUndefined();
  expect(handle.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");

  const warn = (message: string) => {
    throw new Error(`unexpected context-engine degrade: ${message}`);
  };
  // Cron prepare loads this handle, then run-executor selects the engine inside the scoped registry.
  const lease = await withPluginRuntimeRegistryScope(handle, () =>
    createContextEngineLogicalTurnLease({
      identity: { runId: "test-run", sessionId: "test-session" },
      config,
      warn,
      workspaceDir,
    }),
  );
  try {
    expect(lease.effectiveEngineId).toBe("ce-probe");
    expect(lease.degraded).toBe(false);
  } finally {
    await lease.dispose();
  }
  await clearActivePluginRegistry();
  expect(getSandboxBackendFactory(SANDBOX_PROBE_ID)).toBe(previousSandboxFactory);
});

it("retains the adopted engine through reload, accepted commit and engine disposal", async () => {
  useNoBundledPlugins();
  const event = `context-consumer-${randomUUID()}`;
  const events: Array<{ kind: string; owner: string }> = [];
  const record = (entry: { kind: string; owner: string }) => events.push(entry);
  process.on(event, record);
  const plugin = writePlugin({
    id: "retained-engine",
    body: `module.exports = { id: "retained-engine", register(api) {
      if (api.registrationMode !== "full") return;
      const owner = require("node:crypto").randomUUID();
      const record = (kind) => process.emit(${JSON.stringify(event)}, { kind, owner });
      api.lifecycle.onDispose(() => record("plugin-disposed"));
      api.registerContextEngine("retained-engine", () => {
        record("created");
        return {
          info: { id: "retained-engine", name: "Retained Engine" },
          ingest: async () => ({ ingested: false }),
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 0, systemPromptAddition: owner }),
          compact: async () => ({ ok: true, compacted: false }),
          commitTurn: async () => { record("committed"); return { status: "committed" }; },
          dispose: async () => record("engine-disposed"),
        };
      });
    } };`,
  });
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none", contextEngine: plugin.id },
    },
  };
  const load = () => loadAndActivateRootPluginRegistry({ config, cache: false });
  const root = load();
  const handle = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [],
    config,
    workspaceDir: plugin.dir,
  });
  const lease = await withPluginRuntimeRegistryScope(handle, () =>
    createContextEngineLogicalTurnLease({
      identity: { runId: "retained-turn", sessionId: "retained-session" },
      config,
    }),
  );
  const engine = lease.begin().engine;
  const original = (await engine.assemble({ sessionId: "retained-session", messages: [] }))
    .systemPromptAddition;
  const lateAssemble = engine.assemble.bind(engine);
  let rawRetirement: Promise<void> | undefined;
  let nextLease: Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>> | undefined;
  try {
    vi.useFakeTimers();
    const successor = load();
    let retired = false;
    rawRetirement = disposePluginRegistryInstances(root, successor).then(() => {
      retired = true;
    });
    const observation = await waitForPluginRegistryRetirement(root, { deferConsumers: true });
    await vi.advanceTimersByTimeAsync(10_001);
    const admission = {
      agentId: "main",
      sessionId: "retained-session",
      sessionKey: "agent:main:retained-session",
      storePath: "sqlite://synthetic",
      generation: "synthetic-generation",
      entryId: "user-entry",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: "retained-turn",
      role: "user" as const,
    };
    if (!engine.commitTurn) {
      throw new Error("Missing original engine commit");
    }
    await expect(
      engine.commitTurn({
        advancementKey: "synthetic-accepted-turn",
        admission,
        terminal: {
          ...admission,
          entryId: "terminal-entry",
          rawSeq: 2,
          effectiveParentId: "user-entry",
          activeMessagePosition: 1,
        },
        messages: [],
        sessionId: admission.sessionId,
      }),
    ).resolves.toEqual({ status: "committed" });
    expect(observation.deferredPluginIds).toEqual([plugin.id]);
    expect(retired).toBe(false);
    expect(events.filter(({ owner }) => owner === original).map(({ kind }) => kind)).toEqual([
      "created",
      "committed",
    ]);
    await lease.dispose();
    await rawRetirement;
    expect(events.filter(({ owner }) => owner === original).map(({ kind }) => kind)).toEqual([
      "created",
      "committed",
      "engine-disposed",
      "plugin-disposed",
    ]);
    await expect(async () =>
      lateAssemble({ sessionId: admission.sessionId, messages: [] }),
    ).rejects.toThrow(/closed|disposed|reloaded|disabled/);
    nextLease = await createContextEngineLogicalTurnLease({
      identity: { runId: "next-turn", sessionId: "next-session" },
      config,
    });
    const next = await nextLease
      .begin()
      .engine.assemble({ sessionId: "next-session", messages: [] });
    expect(next.systemPromptAddition).not.toBe(original);
    expect(nextLease.degraded).toBe(false);
    expect(getActivePluginRegistry()).toBe(successor);
  } finally {
    await lease.dispose();
    await nextLease?.dispose();
    await rawRetirement;
    vi.useRealTimers();
    process.off(event, record);
  }
});

it("uses an unchanged adopted instance after its original cache retires", async () => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "unchanged-engine",
    body: `module.exports = { id: "unchanged-engine", register(api) {
      if (api.registrationMode !== "full") return;
      api.registerContextEngine("unchanged-engine", () => ({
        info: { id: "unchanged-engine", name: "Unchanged Engine" },
        ingest: async () => ({ ingested: false }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0, systemPromptAddition: "unchanged-owner" }),
        compact: async () => ({ ok: true, compacted: false }),
      }));
    } };`,
  });
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none", contextEngine: plugin.id },
    },
  };
  const originalCache = createPluginCache();
  const currentCache = createPluginCache();
  const root = withPluginCache(originalCache, () => loadAndActivateRootPluginRegistry({ config }));
  const successor = withPluginCache(currentCache, () =>
    loadAndActivateRootPluginRegistry({ config, previousRegistry: root }),
  );
  expect(successor.plugins[0]).toBe(root.plugins[0]);
  await retirePluginCache(originalCache);
  const warn = () => {};
  const lease = await withPluginRuntimeRegistryScope(successor, () =>
    createContextEngineLogicalTurnLease({
      identity: { runId: "unchanged-turn", sessionId: "unchanged-session" },
      config,
      warn,
    }),
  );
  try {
    expect(lease.degraded).toBe(false);
    await expect(
      lease.begin().engine.assemble({ sessionId: "unchanged-session", messages: [] }),
    ).resolves.toMatchObject({ systemPromptAddition: "unchanged-owner" });
    expect(getActivePluginRegistry()).toBe(successor);
  } finally {
    await lease.dispose();
    await disposePluginRegistryInstances(successor);
    await retirePluginCache(currentCache);
  }
});

it.each(["factory", "contract"] as const)(
  "releases the adopted consumer after %s failure",
  async (failure) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failed-engine",
      body: `module.exports = { id: "failed-engine", register(api) {
      if (api.registrationMode !== "full") return;
      api.registerContextEngine("failed-engine", async () => {
        await Promise.resolve();
        ${failure === "factory" ? 'throw new Error("synthetic factory failure");' : 'return { info: { id: "failed-engine", name: "Invalid Engine" }, dispose: async () => {} };'}
      });
    } };`,
    });
    const config = {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none", contextEngine: plugin.id },
      },
    };
    const root = loadAndActivateRootPluginRegistry({ config, cache: false });
    const handle = loadAgentRuntimePluginRegistryHandle({
      basePluginIds: [],
      config,
      workspaceDir: plugin.dir,
    });
    const lease = await withPluginRuntimeRegistryScope(handle, () =>
      createContextEngineLogicalTurnLease({
        identity: { runId: "failed-turn", sessionId: "failed-session" },
        config,
        warn: () => {},
      }),
    );
    try {
      expect(lease.degraded).toBe(true);
      expect(lease.degradedReason).toContain(
        failure === "factory" ? "synthetic factory failure" : "missing ingest()",
      );
      await expect(disposePluginRegistryInstances(root)).resolves.toMatchObject({ failures: [] });
    } finally {
      await lease.dispose();
      await disposePluginRegistryInstances(root);
    }
  },
);

it("revokes earlier engine callbacks while its raw disposal remains admitted", async () => {
  useNoBundledPlugins();
  const event = `closing-engine-${randomUUID()}`;
  const disposeEntered = createDeferredCore();
  const lateResult = createDeferredCore<string>();
  const events: string[] = [];
  const record = (kind: string) => {
    events.push(kind);
    if (kind === "dispose-entered") {
      disposeEntered.resolve();
    }
    if (kind.startsWith("late-")) {
      lateResult.resolve(kind);
    }
  };
  process.on(event, record);
  const plugin = writePlugin({
    id: "closing-engine",
    body: `module.exports = { id: "closing-engine", register(api) {
      if (api.registrationMode !== "full") return;
      const late = new Promise((resolve) => process.once(${JSON.stringify(event + "-late")}, resolve));
      const finish = new Promise((resolve) => process.once(${JSON.stringify(event + "-finish")}, resolve));
      const record = (kind) => process.emit(${JSON.stringify(event)}, kind);
      const route = (text) => api.runtime.system.enqueueSystemEvent(text, { sessionKey: ${JSON.stringify(event)} });
      api.registerContextEngine("closing-engine", () => ({
        info: { id: "closing-engine", name: "Closing Engine" },
        ingest: async () => ({ ingested: false }),
        assemble: async ({ messages }) => {
          void (async () => {
            await late;
            try { route("late"); record("late-accepted"); }
            catch { record("late-rejected"); }
          })();
          return { messages, estimatedTokens: 0 };
        },
        compact: async () => ({ ok: true, compacted: false }),
        dispose: async () => {
          record("dispose-entered");
          await finish;
          route("dispose-finished");
          record("dispose-finished");
        },
      }));
    } };`,
  });
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none", contextEngine: plugin.id },
    },
  };
  loadAndActivateRootPluginRegistry({ config, cache: false });
  const lease = await createContextEngineLogicalTurnLease({
    identity: { runId: "closing-turn", sessionId: "closing-session" },
    config,
  });
  await lease.begin().engine.assemble({ sessionId: "closing-session", messages: [] });
  const retiring = clearActivePluginRegistry();
  const disposal = lease.dispose();
  try {
    await disposeEntered.promise;
    process.emit(event + "-late");
    expect(await lateResult.promise).toBe("late-rejected");
    expect(events).not.toContain("dispose-finished");
  } finally {
    process.emit(event + "-late");
    process.emit(event + "-finish");
    await Promise.all([disposal, retiring]);
    process.off(event, record);
    drainSystemEvents(event);
  }
  expect(events).toContain("dispose-finished");
});
