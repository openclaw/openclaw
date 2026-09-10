import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { SessionManager } from "../sessions/session-manager.js";
import { compactEmbeddedAgentSession } from "./compact.queued.js";
import { waitForDeferredTurnMaintenanceForSession } from "./context-engine-maintenance.js";

// Exercise the existing managed producer without enabling RUN resource disposal.
vi.mock("../prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prepared-model-runtime.js")>();
  return {
    ...actual,
    acquireAgentRunPreparedModelRuntime: (
      input: Parameters<typeof actual.acquireAgentRunPreparedModelRuntime>[0],
      options: Parameters<typeof actual.acquireAgentRunPreparedModelRuntime>[1],
    ) => {
      const provider = input.config.plugins?.allow?.[0];
      if (!provider) {
        throw new Error("Foreground fixture provider is missing");
      }
      return actual.acquireReadOnlyPreparedModelRuntime(
        {
          ...input,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider, modelId: "model", agentId: "main" }],
        },
        options?.abortSignal,
        "static",
      );
    },
  };
});

it.each([
  { mode: "timeout", factory: "none", deferred: false },
  { mode: "caller-abort", factory: "none", deferred: false },
  { mode: "success-tail", factory: "none", deferred: false },
  { mode: "factory-service", factory: "service", deferred: false },
  { mode: "factory-signal", factory: "signal", deferred: false },
  { mode: "operation-signal", factory: "service", deferred: false },
  { mode: "deferred-factory-service", factory: "service", deferred: true },
  { mode: "deferred-factory-signal", factory: "signal", deferred: true },
] as const)(
  "retains $mode resources through disposal without retaining write authority",
  async ({ mode, factory, deferred }) => {
    const state = await createOpenClawTestState({
      prefix: "openclaw-foreground-compaction-",
      layout: "split",
    });
    try {
      const pluginId = `foreground-${mode}-fixture`;
      const pluginRoot = state.path("plugin");
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
        JSON.stringify({
          id: pluginId,
          providers: [pluginId],
          configSchema: { type: "object" },
        }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "index.cjs"),
        `module.exports = {
          id: '${pluginId}', register(api) {
            api.registerProvider({ id: '${pluginId}', label: 'Foreground fixture', auth: [] });
          }
        };`,
      );
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: `${pluginId}/model` },
            compaction: { timeoutSeconds: 1 },
          },
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
      const target = {
        agentId: "main",
        sessionId: "foreground-registration",
        sessionKey: "agent:main:foreground-registration",
        storePath: state.path("sessions.sqlite"),
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        lifecycleRevision: "foreground-lifecycle",
        activeWriterRunId: "foreground-writer",
      });
      const firstEntryId = SessionManager.open(target, state.workspaceDir).appendMessage({
        role: "user",
        content: "Preserve this conversation.",
        timestamp: 1,
      });
      const entryBefore = structuredClone(loadSessionEntryReadOnly(target));
      const transcriptBefore = loadTranscriptEventsSync(target);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const disposalEntered = createDeferredCore();
      const cleanupTailEntered = createDeferredCore();
      const finishDisposal = createDeferredCore();
      const closed = createDeferredCore();
      const stopFactory = createDeferredCore();
      const forceDisposal = createDeferredCore();
      const factoryAborted = createDeferredCore();
      const operationAborted = createDeferredCore();
      const parent = deferred ? new AsyncWorkScope() : undefined;
      let factorySignal: AbortSignal | undefined;
      let factoryCloseContextMatches = false;
      let factoryClosedAfterDisposalStarted = false;
      const work: Promise<unknown>[] = [];
      const values: unknown[] = [];
      let lateWriteBlocked = false;
      let disposalCalls = 0;
      let physicalDisposals = 0;
      let workSignal: AbortSignal | undefined;
      let backendSignal: AbortSignal | undefined;
      let disposalContextMatches = false;
      let selectedRegistry: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
      const file = state.path("registration.sqlite");
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
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
      source.runRegistration(pluginId, () => {
        api.lifecycle.registerRuntimeLifecycle({
          id: "database",
          dispose() {
            physicalDisposals++;
            db.close();
            closed.resolve();
          },
        });
        api.registerContextEngine(pluginId, () => {
          if (factory !== "none") {
            factorySignal = getAsyncWorkSignal();
            const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
            factorySignal?.addEventListener(
              "abort",
              () => {
                factoryCloseContextMatches =
                  getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry;
                factoryClosedAfterDisposalStarted = disposalCalls > 0;
                factoryAborted.resolve();
              },
              { once: true },
            );
            const service = trackAsyncWork(async () => {
              await stopFactory.promise;
              values.push(db.prepare("SELECT value FROM answer").get()?.value);
            });
            work.push(service);
            void service.catch(() => {});
          }
          return {
            info: {
              id: pluginId,
              name: "Foreground fixture",
              ownsCompaction: true,
              ...(deferred ? { turnMaintenanceMode: "background" as const } : {}),
            },
            ingest: async () => ({ ingested: false }),
            assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
            async maintain() {
              selectedRegistry = getPluginRuntimeGatewayRequestScope();
              entered.resolve();
              await resume.promise;
              return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
            },
            compact(params) {
              if (deferred) {
                throw new Error("Expected deferred maintenance");
              }
              workSignal = getAsyncWorkSignal();
              workSignal?.addEventListener("abort", () => operationAborted.resolve(), {
                once: true,
              });
              backendSignal = params.abortSignal;
              selectedRegistry = getPluginRuntimeGatewayRequestScope();
              if (factory !== "none") {
                entered.resolve();
                return Promise.resolve({ ok: true, compacted: false });
              }
              const manager = SessionManager.open(target, state.workspaceDir);
              const compact = async () => {
                entered.resolve();
                await resume.promise;
                if (mode === "success-tail") {
                  workSignal?.throwIfAborted();
                }
                try {
                  manager.appendCompaction("Late summary", firstEntryId, 100);
                } catch {
                  lateWriteBlocked = true;
                }
                values.push(db.prepare("SELECT value FROM answer").get()?.value);
                return { ok: true, compacted: false };
              };
              const pending = mode === "success-tail" ? trackAsyncWork(compact) : compact();
              work.push(pending);
              void pending.catch(() => {});
              return mode === "success-tail"
                ? Promise.resolve({ ok: true, compacted: false })
                : pending;
            },
            async dispose() {
              disposalCalls++;
              disposalEntered.resolve();
              const capturedSignal =
                mode === "operation-signal"
                  ? workSignal
                  : factory === "signal"
                    ? factorySignal
                    : undefined;
              if (capturedSignal && !capturedSignal.aborted) {
                await Promise.race([
                  mode === "operation-signal" ? operationAborted.promise : factoryAborted.promise,
                  forceDisposal.promise,
                ]);
              }
              stopFactory.resolve();
              disposalContextMatches =
                getPluginRuntimeGatewayRequestScope()?.pluginRegistry ===
                selectedRegistry?.pluginRegistry;
              const pending = trackAsyncWork(async () => {
                cleanupTailEntered.resolve();
                await finishDisposal.promise;
                values.push(db.prepare("SELECT value FROM answer").get()?.value);
              });
              work.push(pending);
              void pending.catch(() => {});
            },
          };
        });
      });
      setActivePluginRegistry(donor.registry);
      const caller = new AbortController();
      const callerReason = new Error("foreground compaction caller cancelled");
      let pending: Promise<unknown> | undefined;
      try {
        expect(getAsyncWorkSignal()).toBeUndefined();
        const start = () =>
          compactEmbeddedAgentSession({
            ...target,
            sessionTarget: target,
            sessionFile: target.sessionKey,
            workspaceDir: state.workspaceDir,
            agentDir: state.agentDir(),
            config,
            provider: pluginId,
            model: "model",
            trigger: deferred ? "budget" : "manual",
            ...(deferred ? { deferOwningContextEngineCompaction: true } : {}),
            abortSignal: caller.signal,
            enqueue: async (task) => await task(),
          });
        const completion = parent ? parent.run(start) : start();
        pending = completion;
        if (deferred) {
          await completion;
          await withTestTimeout(
            entered.promise,
            5_000,
            "Deferred factory never entered maintenance",
          );
        } else {
          await Promise.race([
            entered.promise,
            completion.then(() => {
              throw new Error("Compaction ended before the backend entered");
            }),
          ]);
        }
        if (mode === "caller-abort") {
          caller.abort(callerReason);
        }
        const result = await completion;
        expect(result).toMatchObject({
          ok: mode === "success-tail" || factory !== "none",
          compacted: false,
        });
        if (parent) {
          parent.beginClose(new Error("Foreground caller retired"));
          await withTestTimeout(
            parent.drain(),
            1_000,
            "Foreground parent retained transferred factory work",
          );
          expect(factorySignal?.aborted ?? false).toBe(false);
        }
        if (mode === "timeout") {
          expect(result.reason).toContain("timed out");
          expect(caller.signal.aborted).toBe(false);
          expect(backendSignal?.aborted).toBe(true);
        }
        if (mode === "caller-abort") {
          expect(backendSignal?.reason === callerReason).toBe(true);
        }
        await source.release();
        expect.soft(db.isOpen).toBe(true);
        if (factory === "none" || deferred) {
          expect.soft(disposalCalls).toBe(0);
        }
        if (factory === "none") {
          expect.soft(workSignal?.aborted ?? false).toBe(false);
        }
        resume.resolve();
        if (factory === "none") {
          await Promise.allSettled(work.slice(0, 1));
        }
        await withTestTimeout(
          disposalEntered.promise,
          1_000,
          "Factory service prevented disposal from starting",
        );
        await withTestTimeout(
          cleanupTailEntered.promise,
          1_000,
          "Disposer remained blocked on a captured work signal",
        );
        expect.soft(db.isOpen).toBe(true);
        expect.soft(disposalContextMatches).toBe(true);
        expect.soft(physicalDisposals).toBe(0);
        finishDisposal.resolve();
        const outcomes = await Promise.allSettled(work);
        expect.soft(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        await closed.promise;
        expect(values).toEqual([42, 42]);
        if (factory === "none") {
          expect(lateWriteBlocked).toBe(true);
        } else if (factorySignal) {
          expect(factorySignal.aborted).toBe(true);
          expect(factoryCloseContextMatches).toBe(true);
          expect(factoryClosedAfterDisposalStarted).toBe(true);
        }
        expect(loadTranscriptEventsSync(target)).toEqual(transcriptBefore);
        expect(loadSessionEntryReadOnly(target)).toEqual(entryBefore);
        expect(disposalCalls).toBe(1);
        expect(physicalDisposals).toBe(1);
        expect(db.isOpen).toBe(false);
        const reopened = new DatabaseSync(file, { readOnly: true });
        try {
          expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
        } finally {
          reopened.close();
        }
      } finally {
        resume.resolve();
        finishDisposal.resolve();
        stopFactory.resolve();
        forceDisposal.resolve();
        await Promise.allSettled([...(pending ? [pending] : []), ...work]);
        await waitForDeferredTurnMaintenanceForSession(target.sessionKey);
        await parent?.drain();
        await closePreparedModelRuntimeSnapshots();
        await source.release();
        resetPluginRuntimeStateForTest();
        clearPluginMetadataLifecycleCaches();
        if (db.isOpen) {
          db.close();
        }
      }
    } finally {
      await state.cleanup();
    }
  },
);
