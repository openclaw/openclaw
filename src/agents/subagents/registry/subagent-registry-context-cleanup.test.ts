import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import {
  registerContextEngineInRegistry,
  resolveContextEngine,
} from "../../../context-engine/registry.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../../plugins/registry-inspection.test-support.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import {
  resetSubagentRegistryRuntimeLoadersForTests,
  setSubagentRegistryDepsForTest,
  subagentRegistryDeps,
} from "./subagent-registry-deps.js";

describe("subagent registry context cleanup", () => {
  afterEach(() => {
    setSubagentRegistryDepsForTest();
    resetSubagentRegistryRuntimeLoadersForTests();
  });

  it.each(["success", "hook-error", "stale", "absent"] as const)(
    "retires resolved engine resources after ended-hook work (%s)",
    async (mode) => {
      const registry = createEmptyPluginRegistry();
      const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
      resources.attach(registry);
      const retire = vi.fn();
      resources.register("fixture", { id: "resource", dispose: retire });
      const resolutionStarted = createDeferred();
      const resolutionGate = createDeferred();
      const cleanupStarted = createDeferred();
      const cleanupGate = createDeferred();
      const hookError = new Error("ended hook failed");
      const cleanupError = new Error("engine cleanup failed");
      const onSubagentEnded = vi.fn(async () => {
        expect(retire).not.toHaveBeenCalled();
        if (mode === "hook-error") {
          throw hookError;
        }
      });
      const raw = Object.assign(new LegacyContextEngine(), {
        ...(mode === "absent" ? {} : { onSubagentEnded }),
        async dispose() {
          cleanupStarted.resolve();
          await cleanupGate.promise;
          if (mode === "hook-error") {
            throw cleanupError;
          }
        },
      });
      registerContextEngineInRegistry(registry, "legacy", () => raw, "core");
      let engine: ContextEngine | undefined;
      let current = true;
      setSubagentRegistryDepsForTest({
        getRuntimeConfig: () => ({}),
        loadAgentRuntimePluginRegistryHandle: () => registry,
        ensureContextEnginesInitialized: vi.fn(),
        resolveContextEngine: async (cfg, options) => {
          engine = await resolveContextEngine(cfg, options);
          resolutionStarted.resolve();
          await resolutionGate.promise;
          return engine;
        },
      });
      const cleanup = createSubagentRegistryContextCleanup({
        deps: () => subagentRegistryDeps,
        persist: vi.fn(),
        warn: vi.fn(),
      });
      const pending = cleanup.runContextEngineSubagentEnded(
        { childSessionKey: "agent:main:subagent:owned", reason: "completed" },
        { isCurrent: () => current },
      );
      const result = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await resolutionStarted.promise;
        current = mode !== "stale";
        resolutionGate.resolve();
        expect(
          await Promise.race([
            cleanupStarted.promise.then(() => "cleanup"),
            result.then(() => "returned"),
          ]),
        ).toBe("cleanup");
        await resources.release();
        expect(retire).not.toHaveBeenCalled();
        cleanupGate.resolve();
        expect(await result).toBe(mode === "hook-error" ? hookError : undefined);
        expect(onSubagentEnded).toHaveBeenCalledTimes(
          mode === "stale" || mode === "absent" ? 0 : 1,
        );
        expect(retire).toHaveBeenCalledTimes(1);
      } finally {
        resolutionGate.resolve();
        cleanupGate.resolve();
        await result;
        await engine?.dispose?.().catch(() => {});
        await resources.release();
      }
    },
  );

  it("completes ended-hook cleanup when the plugin runtime loader rejects", async () => {
    const error = new Error("plugin runtime import failed");
    setSubagentRegistryDepsForTest({
      getRuntimeConfig: () => ({}),
      loadAgentRuntimePluginRegistryHandle: () => {
        throw error;
      },
    });
    const warn = vi.fn();
    const persist = vi.fn();
    const cleanup = createSubagentRegistryContextCleanup({
      deps: () => subagentRegistryDeps,
      persist,
      warn,
    });
    const entry = createSubagentRunRecord({ runId: "run-ended", endedAt: 4_000 });

    await expect(cleanup.emitSubagentEndedHookForRun({ entry })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("subagent_ended hook failed (best-effort)", {
      phase: "plugin-runtime",
      err: error,
    });
    expect(entry.endedHookEmittedAt).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });
});
