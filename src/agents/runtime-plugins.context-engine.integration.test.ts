// Verifies prepared agent turns retain their selected runtime context-engine owner.
import { afterAll, afterEach, expect, it } from "vitest";
import { resetContextEngineRuntimeQuarantineForTests } from "../context-engine/registry.test-support.js";
import { loadAndActivateRootPluginRegistry, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearActivePluginRegistry, getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
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
