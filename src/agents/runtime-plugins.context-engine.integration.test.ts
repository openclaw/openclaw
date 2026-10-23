// Verifies prepared agent turns retain their selected runtime context-engine owner.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { PluginInstanceDrainTimeoutError } from "../plugins/plugin-instance-error.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";
import { getSandboxBackendFactory } from "./sandbox/backend.js";

const SANDBOX_PROBE_ID = "scoped-load-probe";
const configFor = (plugin: ReturnType<typeof writePlugin>): OpenClawConfig => ({
  plugins: {
    allow: [plugin.id],
    load: { paths: [plugin.file] },
    slots: { memory: "none", contextEngine: plugin.id },
  },
});
const preparedHandle = (config: OpenClawConfig, workspaceDir: string) =>
  loadAgentRuntimePluginRegistryHandle({ basePluginIds: [], config, workspaceDir });
const turnLease = (config: OpenClawConfig, name: string) =>
  createContextEngineLogicalTurnLease({
    identity: { runId: `${name}-turn`, sessionId: `${name}-session` },
    config,
  });
function enginePlugin(id: string, members: string, fullOnly = true, asynchronous = false) {
  return writePlugin({
    id,
    body: `module.exports = { id: ${JSON.stringify(id)}, register(api) {
      ${fullOnly ? 'if (api.registrationMode !== "full") return;' : ""}
      api.registerContextEngine(${JSON.stringify(id)}, ${asynchronous ? "async " : ""}() => ({
        info: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)} },
        ingest: async () => ({ ingested: false }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        ${members}
      }));
    } };`,
  });
}
beforeEach(() => useNoBundledPlugins());
afterEach(async () => {
  await clearActivePluginRegistry();
  await resetContextEngineRuntimeQuarantineForTests();
  resetPluginLoaderTestStateForTest();
});

afterAll(() => cleanupPluginLoaderFixturesForTest());

it.each([false, true])(
  "keeps the configured engine in scoped handles without global setup (full-only: %s)",
  async (fullOnly) => {
    const previousSandboxFactory = getSandboxBackendFactory(SANDBOX_PROBE_ID);
    const contextEngine = enginePlugin(
      "ce-probe",
      `
        ingest: async () => ({ ingested: ${fullOnly} }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0, systemPromptAddition: "prepared-engine" }),
        dispose: async () => {},
  `,
      fullOnly,
      fullOnly,
    );
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
        slots: { contextEngine: "ce-probe" },
        ...(fullOnly
          ? {
              allow: ["ce-probe", "sandbox-probe"],
              entries: { "ce-probe": { enabled: true }, "sandbox-probe": { enabled: true } },
            }
          : {}),
      },
    };
    const workspaceDir = makePluginLoaderTempDir();
    const root = await loadAndActivateRootPluginRegistry({
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
      basePluginIds: fullOnly ? ["ce-probe", "sandbox-probe"] : [],
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
    expect(handle.plugins.find((plugin) => plugin.id === "sandbox-probe")?.status).toBe(
      fullOnly ? "loaded" : undefined,
    );
    expect(getSandboxBackendFactory(SANDBOX_PROBE_ID)).toBe(rootSandboxFactory);
    expect(discovery.contextEngines.has("ce-probe")).toBe(!fullOnly);
    expect(handle.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");

    using warnings = vi.spyOn(console, "warn");
    warnings.mockImplementation((message: string) => {
      throw new Error(`unexpected context-engine degrade: ${message}`);
    });
    // Cron prepare loads this handle, then run-executor selects the engine inside the scoped registry.
    const lease = await withPluginRuntimeRegistryScope(handle, () =>
      createContextEngineLogicalTurnLease({
        identity: { runId: "test-run", sessionId: "test-session" },
        config,
        workspaceDir,
      }),
    );
    try {
      expect(lease).toMatchObject({
        effectiveEngineId: "ce-probe",
        effectiveEnginePluginId: "ce-probe",
        degraded: false,
      });
      await expect(
        lease.begin().engine.assemble({ messages: [], sessionId: "prepared-session" }),
      ).resolves.toMatchObject({ systemPromptAddition: "prepared-engine" });
    } finally {
      await lease.dispose();
    }
    await clearActivePluginRegistry();
    expect(getSandboxBackendFactory(SANDBOX_PROBE_ID)).toBe(previousSandboxFactory);
  },
);

it("retains the adopted engine through reload, accepted commit and engine disposal", async () => {
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
  const config = configFor(plugin);
  const load = () => loadAndActivateRootPluginRegistry({ config, cache: false });
  const root = await load();
  const handle = preparedHandle(config, plugin.dir);
  const lease = await withPluginRuntimeRegistryScope(handle, () => turnLease(config, "retained"));
  const engine = lease.begin().engine;
  const original = (await engine.assemble({ sessionId: "retained-session", messages: [] }))
    .systemPromptAddition;
  const originalEvents = () =>
    events.filter(({ owner }) => owner === original).map(({ kind }) => kind);
  const lateAssemble = engine.assemble.bind(engine);
  let rawRetirement: Promise<void> | undefined;
  let nextLease: Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>> | undefined;
  try {
    vi.useFakeTimers();
    const successor = await load();
    let retired = false;
    rawRetirement = disposePluginRegistryInstances(root, successor).then(async (result) => {
      const timeout = result.failures[0]?.error;
      expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
      if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
        throw new Error("Expected bounded retirement while the engine consumer is retained");
      }
      expect(timeout.forcedRetirement?.retainedConsumerCount).toBeGreaterThan(0);
      await timeout.settled;
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
    expect(originalEvents()).toEqual(["created", "committed"]);
    await lease.dispose();
    await rawRetirement;
    expect(originalEvents()).toEqual([
      "created",
      "committed",
      "engine-disposed",
      "plugin-disposed",
    ]);
    await expect(async () =>
      lateAssemble({ sessionId: admission.sessionId, messages: [] }),
    ).rejects.toThrow(/closed|disposed|reloaded|disabled/);
    nextLease = await turnLease(config, "next");
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
  const plugin = enginePlugin(
    "unchanged-engine",
    `
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0, systemPromptAddition: "unchanged-owner" }),
  `,
  );
  const config = configFor(plugin);
  const originalCache = createPluginCache();
  const currentCache = createPluginCache();
  const root = await withPluginCache(originalCache, () =>
    loadAndActivateRootPluginRegistry({ config }),
  );
  const successor = await withPluginCache(currentCache, () =>
    loadAndActivateRootPluginRegistry({ config, previousRegistry: root }),
  );
  expect(successor.plugins[0]).toBe(root.plugins[0]);
  await retirePluginCache(originalCache);
  const lease = await withPluginRuntimeRegistryScope(successor, () =>
    turnLease(config, "unchanged"),
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
    const config = configFor(plugin);
    const root = await loadAndActivateRootPluginRegistry({ config, cache: false });
    const handle = preparedHandle(config, plugin.dir);
    const lease = await withPluginRuntimeRegistryScope(handle, () => turnLease(config, "failed"));
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
  const event = `closing-engine-${randomUUID()}`;
  const events: string[] = [];
  const record = (kind: string) => events.push(kind);
  process.on(event, record);
  const plugin = writePlugin({
    id: "closing-engine",
    body: `module.exports = { id: "closing-engine", register(api) {
      if (api.registrationMode !== "full") return;
      const late = new Promise((resolve) => process.once(${JSON.stringify(event + "-late")}, resolve));
      const finish = new Promise((resolve) => process.once(${JSON.stringify(event + "-finish")}, resolve));
      const record = (kind) => process.emit(${JSON.stringify(event)}, kind);
      const route = (text) => api.runtime.system.enqueueSystemEvent(text, { sessionKey: ${JSON.stringify(`agent:main:${event}`)} });
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
  const config = configFor(plugin);
  await loadAndActivateRootPluginRegistry({ config, cache: false });
  const lease = await turnLease(config, "closing");
  await lease.begin().engine.assemble({ sessionId: "closing-session", messages: [] });
  const disposeEntered = once(process, event);
  const retiring = clearActivePluginRegistry();
  const disposal = lease.dispose();
  try {
    expect(await disposeEntered).toEqual(["dispose-entered"]);
    const lateResult = once(process, event);
    process.emit(event + "-late");
    expect(await lateResult).toEqual(["late-rejected"]);
    expect(events).not.toContain("dispose-finished");
  } finally {
    process.emit(event + "-late");
    process.emit(event + "-finish");
    await Promise.all([disposal, retiring]);
    process.off(event, record);
    drainSystemEvents(`agent:main:${event}`);
  }
  expect(events).toContain("dispose-finished");
});
