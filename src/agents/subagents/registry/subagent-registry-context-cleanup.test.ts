import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement as awaitGate,
  createDeferred,
} from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import {
  registerContextEngineInRegistry,
  resolveContextEngine,
} from "../../../context-engine/registry.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../../plugins/registry-inspection.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope, trackAsyncWork } from "../../../shared/async-work-scope.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { resolveSubagentSessionAttachmentRootDir } from "../subagent-attachment-paths.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import { createSubagentTestGate } from "./subagent-registry-lifecycle-controller.test-support.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import * as registryPersistence from "./subagent-registry-persistence.js";
import {
  createArchivedSubagentSweeperRun,
  createSubagentSweeperHarness,
} from "./subagent-registry-sweeper.test-support.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../context-engine/registry.js", { spy: true });
vi.mock("../../../context-engine/init.js", () => ({ ensureContextEnginesInitialized: vi.fn() }));
vi.mock("./subagent-session-reconciliation.js", { spy: true });
vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: vi.fn(),
}));
vi.mock("../../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: vi.fn<typeof loadAgentRuntimePluginRegistryHandle>(),
}));

const { resolveContextEngine: actualResolveContextEngine } = await vi.importActual<
  typeof import("../../../context-engine/registry.js")
>("../../../context-engine/registry.js");

function createCleanup(engine?: Partial<ContextEngine>, owner = true, warn = vi.fn()) {
  const registry = createEmptyPluginRegistry();
  const nativeWarn = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(warn);
  onTestFinished(() => nativeWarn.mockRestore());
  const cleanup = createSubagentRegistryContextCleanup({
    isEndedHookOwnerCurrent: () => owner,
  });
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  if (engine) {
    registerContextEngineInRegistry(
      registry,
      "legacy",
      () => Object.assign(new LegacyContextEngine(), engine),
      "core",
    );
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
    vi.mocked(resolveContextEngine).mockImplementation(actualResolveContextEngine);
  }
  return { registry, cleanup, warn };
}

describe("subagent registry context cleanup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(removeInternalSessionEffectsSession).mockReset();
    vi.mocked(getRuntimeConfig).mockReset();
    vi.mocked(resolveContextEngine).mockReset();
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    vi.mocked(loadSubagentSessionEntry).mockReset();
  });

  it.each(["session tail", "inline collector"] as const)(
    "owns swept context cleanup after the timer's caller scope closes (%s)",
    async (mode) => {
      vi.useFakeTimers();
      resetGatewayWorkAdmission();
      const engineGate = createSubagentTestGate();
      const disposalGate = createSubagentTestGate();
      const descendantGate = createSubagentTestGate();
      const cleanupFinished = createDeferred();
      const onSubagentEnded = vi.fn();
      const dispose = vi.fn(() => disposalGate.wait());
      vi.mocked(loadSubagentSessionEntry).mockResolvedValue({
        sessionId: "swept-session",
        lifecycleRevision: "swept-revision",
        updatedAt: Date.now(),
      });
      const entry = createArchivedSubagentSweeperRun({
        cleanup: "keep",
        spawnMode: "session",
        cleanupCompletedAt: Date.now(),
        archiveAtMs: undefined,
        ...(mode === "inline collector"
          ? {
              collect: true,
              groupId: "swept-group",
              collectorCompletion: { status: "done" },
              archiveAtMs: Date.now() + 5 * 60_000 + 1,
            }
          : {}),
      });
      const { sweeper, runs, warn, ...harness } = createSubagentSweeperHarness({}, entry);
      const { cleanup } = createCleanup({ onSubagentEnded, dispose }, true, warn);
      const runCleanup: typeof cleanup.notifyContextEngineSubagentEnded = async (params) => {
        try {
          await engineGate.wait();
          await (mode === "session tail"
            ? cleanup.notifyContextEngineSubagentEnded(params)
            : cleanup.runContextEngineSubagentEnded(params));
          void trackAsyncWork(() => descendantGate.wait()).catch((error: unknown) =>
            warn("cleanup descendant failed", { error }),
          );
        } finally {
          cleanupFinished.resolve();
        }
      };
      harness.notifyContextEngineSubagentEnded.mockImplementation(runCleanup);
      harness.runContextEngineSubagentEnded.mockImplementation(runCleanup);
      const caller = new AsyncWorkScope();
      const timerContext = caller.run(() => {
        sweeper.start();
        return AsyncLocalStorage.snapshot();
      });
      try {
        await caller.drain();
        // Fake timers need the async context a real Node timer captures when armed.
        await timerContext(() => vi.advanceTimersByTimeAsync(6 * 60_000));
        await vi.dynamicImportSettled();
        expect(getActiveGatewayRootWorkHolders()).toEqual([
          mode === "session tail" ? "subagents:sweeper-cleanup" : "subagents:sweeper",
        ]);
        // The session tail must resolve its engine after the tick has already returned.
        engineGate.release();
        await awaitGate(disposalGate.entered, cleanupFinished.promise, "early return");
        expect(warn).not.toHaveBeenCalled();
        expect(onSubagentEnded).toHaveBeenCalledExactlyOnceWith({
          childSessionKey: entry.childSessionKey,
          reason: "swept",
          agentDir: undefined,
          workspaceDir: undefined,
        });
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        disposalGate.release();
        await cleanupFinished.promise;
        await sweeper.reset();
        expect(runs.size).toBe(0);
        expect(dispose).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        descendantGate.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        engineGate.release();
        disposalGate.release();
        descendantGate.release();
        await sweeper.reset();
        await vi.advanceTimersByTimeAsync(0);
        resetGatewayWorkAdmission();
        vi.useRealTimers();
      }
    },
  );

  it.each(["context engine", "ended hook"] as const)(
    "handles plugin runtime loader failure at the %s boundary",
    async (boundary) => {
      const error = new Error("cleanup failed: Authorization: Bearer synthetic-cleanup-token");
      const { cleanup, warn } = createCleanup();
      vi.mocked(loadAgentRuntimePluginRegistryHandle).mockImplementation(() => {
        throw error;
      });

      if (boundary === "ended hook") {
        using persist = vi.spyOn(registryPersistence, "mutateSubagentRuns");
        const entry = createSubagentRunRecord({ runId: "run-ended", endedAt: 4_000 });
        await expect(cleanup.emitSubagentEndedHookForRun({ entry })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith("subagent_ended hook failed (best-effort)", {
          phase: "plugin-runtime",
          err: error,
        });
        expect(entry.endedHookEmittedAt).toBeUndefined();
        expect(persist).not.toHaveBeenCalled();
        return;
      }
      await cleanup.notifyContextEngineSubagentEnded({
        childSessionKey: "agent:main:subagent:private-session",
        reason: "swept",
      });

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "context-engine onSubagentEnded failed (best-effort)",
        {
          error: { name: "Error", message: expect.stringContaining("cleanup failed") },
          childSessionKey: "agent:main:subagent:private-session",
          reason: "swept",
        },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-cleanup-token");
    },
  );

  it("preserves collector attachments when the registered owner is absent", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-collector-cleanup-"));
    const attachmentId = "2d4a8398-4d5a-4c20-9c16-0a5f6627cf92";
    const entry = createSubagentRunRecord({ runId: "collector-cleanup", attachmentId });
    const attachmentDir = path.join(
      resolveSubagentSessionAttachmentRootDir({
        agentId: "main",
        childSessionKey: entry.childSessionKey,
      }),
      attachmentId,
    );
    await fs.mkdir(attachmentDir, { recursive: true });
    const sentinel = path.join(attachmentDir, "owned.txt");
    await fs.writeFile(sentinel, "successor attachment");
    const { cleanup } = createCleanup();
    await expect(cleanup.cleanupCollectorLaunchResources(entry)).resolves.toBe(false);
    expect(removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("successor attachment");
  });

  it.each(["hook-error", "stale-prepared", "foreign-change", "absent"] as const)(
    "retires resolved engine resources after ended-hook work (%s)",
    async (mode) => {
      const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
      await using resourceScope = { [Symbol.asyncDispose]: () => resources.release() };
      const retire = vi.fn();
      await using resolution = createSubagentTestGate();
      await using disposal = createSubagentTestGate();
      const hookError = new Error("ended hook failed");
      const cleanupError = new Error("engine cleanup failed");
      const onSubagentEnded = vi.fn(async () => {
        expect(retire).not.toHaveBeenCalled();
        if (mode === "hook-error") {
          throw hookError;
        }
      });
      const { registry, cleanup } = createCleanup(
        {
          ...(mode === "absent" ? {} : { onSubagentEnded }),
          async dispose() {
            await disposal.wait();
            if (mode === "hook-error") {
              throw cleanupError;
            }
          },
        },
        false,
      );
      resources.attach(registry);
      resources.register("fixture", { id: "resource", dispose: retire });
      let current = true;
      vi.mocked(resolveContextEngine).mockImplementation(async (cfg, options) => {
        const engine = await actualResolveContextEngine(cfg, options);
        await resolution.wait();
        return engine;
      });
      const pending = cleanup.runContextEngineSubagentEnded(
        { childSessionKey: "agent:main:subagent:owned", reason: "completed" },
        {
          isCurrent: () => current,
          prepareCurrent: async () => {
            if (mode === "stale-prepared") {
              current = false;
            }
            return mode !== "foreign-change";
          },
        },
      );
      const result = resolution.track(
        pending.then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      await resolution.entered;
      resolution.release();
      await awaitGate(disposal.entered, result, "early return");
      await resourceScope[Symbol.asyncDispose]();
      expect(retire).not.toHaveBeenCalled();
      disposal.release();
      expect(await result).toBe(mode === "hook-error" ? hookError : undefined);
      expect(onSubagentEnded).toHaveBeenCalledTimes(mode === "hook-error" ? 1 : 0);
      expect(retire).toHaveBeenCalledTimes(1);
    },
  );
});
