import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { compactEmbeddedAgentSession } from "./compact.queued.js";
import { waitForDeferredTurnMaintenanceForSession } from "./context-engine-maintenance.js";

// Exercise the managed producer at the existing input boundary without enabling RUN disposal.
vi.mock("../prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prepared-model-runtime.js")>();
  return {
    ...actual,
    acquireAgentRunPreparedModelRuntime: (
      input: Parameters<typeof actual.acquireAgentRunPreparedModelRuntime>[0],
      options: Parameters<typeof actual.acquireAgentRunPreparedModelRuntime>[1],
    ) =>
      actual.acquireReadOnlyPreparedModelRuntime(
        {
          ...input,
          loadRuntimePlugins: true,
          runtimePluginSelections: [
            { provider: "queued-resource-fixture", modelId: "model", agentId: "main" },
          ],
        },
        options?.abortSignal,
        "static",
      ),
  };
});

it("keeps an actual prepared registration alive through queued engine maintenance and disposal", async () => {
  await withOpenClawTestState(
    { prefix: "openclaw-queued-registration-", layout: "split" },
    async (state) => {
      const pluginId = "queued-resource-fixture";
      const pluginRoot = state.path("plugin");
      const key = `__queued_resources_${path.basename(state.root)}`;
      const bridge = {
        entered: createDeferredCore(),
        resume: createDeferredCore(),
        disposalEntered: createDeferredCore(),
        finishDisposal: createDeferredCore(),
        closed: createDeferredCore(),
        connections: [] as Array<{ file: string; db: DatabaseSync; disposals: number }>,
        values: [] as unknown[],
      };
      Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.mkdirSync(state.workspaceDir, { recursive: true });
      fs.mkdirSync(state.agentDir(), { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: pluginId,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({ id: pluginId, providers: [pluginId], configSchema: { type: "object" } }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "index.cjs"),
        `
const { DatabaseSync } = require('node:sqlite');
module.exports = { id: '${pluginId}', register(api) {
  const bridge = globalThis[${JSON.stringify(key)}];
  const file = ${JSON.stringify(state.root)} + '/registration-' + bridge.connections.length + '.sqlite';
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES(42)');
  const connection = { file, db, disposals: 0 };
  bridge.connections.push(connection);
  api.lifecycle.registerRuntimeLifecycle({ id: 'database', dispose() { connection.disposals++; db.close(); bridge.closed.resolve(); } });
  api.registerProvider({ id: '${pluginId}', label: 'Queued fixture', auth: [] });
  api.registerContextEngine('${pluginId}', () => ({
    info: { id: '${pluginId}', name: 'Queued fixture', ownsCompaction: true, turnMaintenanceMode: 'background' },
    ingest: async () => ({ ingested: false }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => { throw new Error('Expected deferred maintenance'); },
    async maintain() { bridge.entered.resolve(); await bridge.resume.promise; bridge.values.push(db.prepare('SELECT value FROM answer').get().value); return { changed: false, bytesFreed: 0, rewrittenEntries: 0 }; },
    async dispose() { bridge.disposalEntered.resolve(); await bridge.finishDisposal.promise; bridge.values.push(db.prepare('SELECT value FROM answer').get().value); },
  }));
} };
`,
      );
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: state.workspaceDir, model: { primary: `${pluginId}/model` } },
        },
        models: {
          providers: {
            [pluginId]: {
              api: "openai-completions",
              apiKey: "synthetic-fixture",
              baseUrl: "https://fixture.invalid/v1",
              models: [
                {
                  id: "model",
                  name: "Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginRoot] },
          slots: { memory: "none", contextEngine: pluginId },
          entries: { [pluginId]: { enabled: true } },
        },
      };
      await state.writeConfig(config);
      const donor = createPluginRegistry({
        runtime: createPluginRuntime(),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        activateGlobalSideEffects: false,
      });
      const source = new PluginRegistryInspectionResources();
      source.attach(donor.registry);
      const record = createPluginRecord({
        id: pluginId,
        source: path.join(pluginRoot, "index.cjs"),
      });
      donor.registry.plugins.push(record);
      const api = donor.createApi(record, { config, registrationMode: "full" });
      const file = state.path("donor.sqlite");
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
      const registration = { file, db, disposals: 0 };
      bridge.connections.push(registration);
      source.runRegistration(pluginId, () => {
        api.lifecycle.registerRuntimeLifecycle({
          id: "donor-database",
          dispose() {
            registration.disposals++;
            db.close();
          },
        });
        api.registerContextEngine(pluginId, () => ({
          info: {
            id: pluginId,
            name: "Runtime donor",
            ownsCompaction: true,
            turnMaintenanceMode: "background",
          },
          ingest: async () => ({ ingested: false }),
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
          compact: async () => {
            throw new Error("Expected deferred maintenance");
          },
          async maintain() {
            bridge.entered.resolve();
            await bridge.resume.promise;
            bridge.values.push(db.prepare("SELECT value FROM answer").get()?.value);
            return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
          },
          async dispose() {
            bridge.disposalEntered.resolve();
            await bridge.finishDisposal.promise;
            bridge.values.push(db.prepare("SELECT value FROM answer").get()?.value);
          },
        }));
      });
      setActivePluginRegistry(donor.registry);
      const target = {
        agentId: "main",
        sessionId: "queued-registration",
        sessionKey: "agent:main:queued-registration",
        storePath: state.path("sessions.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
      try {
        const result = await compactEmbeddedAgentSession({
          ...target,
          sessionTarget: target,
          sessionFile: target.sessionKey,
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(),
          config,
          provider: pluginId,
          model: "model",
          trigger: "budget",
          deferOwningContextEngineCompaction: true,
          enqueue: async (task) => await task(),
        });
        expect(result).toMatchObject({ ok: true, compacted: false });
        await bridge.entered.promise;
        await source.release();
        expect(bridge.connections).toHaveLength(2);
        expect.soft(registration.db.isOpen).toBe(true);
        bridge.resume.resolve();
        await bridge.disposalEntered.promise;
        expect.soft(registration.db.isOpen).toBe(true);
        expect.soft(registration.disposals).toBe(0);
        bridge.finishDisposal.resolve();
        await waitForDeferredTurnMaintenanceForSession(target.sessionKey);
        await bridge.closed.promise;
        await vi.waitFor(() =>
          expect(bridge.connections.every((connection) => connection.disposals === 1)).toBe(true),
        );
        expect(bridge.values).toEqual([42, 42]);
        expect(registration.disposals).toBe(1);
        expect(registration.db.isOpen).toBe(false);
        const reopened = new DatabaseSync(registration.file, { readOnly: true });
        try {
          expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
        } finally {
          reopened.close();
        }
      } finally {
        bridge.resume.resolve();
        bridge.finishDisposal.resolve();
        await waitForDeferredTurnMaintenanceForSession(target.sessionKey);
        await closePreparedModelRuntimeSnapshots();
        await source.release();
        resetPluginRuntimeStateForTest();
        clearPluginMetadataLifecycleCaches();
        for (const connection of bridge.connections) {
          if (connection.db.isOpen) {
            connection.db.close();
          }
        }
        Reflect.deleteProperty(globalThis, key);
      }
    },
  );
});
