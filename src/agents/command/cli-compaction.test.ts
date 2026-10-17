// Covers CLI turn compaction lifecycle and external CLI resume-state cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerContextEngineInRegistry } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withEnv } from "../../test-utils/env.js";
import {
  clearPreparedEmbeddedAgentSettings,
  createPreparedEmbeddedAgentSettingsManager,
} from "../agent-project-settings.js";
import { shouldPreemptivelyCompactBeforePrompt } from "../embedded-agent-runner/run/preemptive-compaction.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { ZERO_USAGE_FIXTURE } from "../test-helpers/usage-fixtures.js";
import { cliCompactionBackendEntrypoints } from "./cli-compaction-runtime.test-support.js";
import {
  buildContextEngine,
  createPreparedRuntimeLease,
  defaultSettingsManager,
  prepareCompactionScenario as prepare,
  prepareContextSuccessorScenario,
  recordCliCompactionInStoreImpl,
  resolveCliBackendConfig,
  resolveContextEngineFromRegistry,
  setCliCompactionTestDeps,
  type CliCompactionTestDeps,
} from "./cli-compaction.test-support.js";

type CompactParams = Parameters<ContextEngine["compact"]>[0];
type NativeCompaction = NonNullable<CliCompactionTestDeps["maybeCompactAgentHarnessSession"]>;
type CompactResult = NonNullable<Awaited<ReturnType<ContextEngine["compact"]>>["result"]>;
const successfulCompaction = (result: CompactResult) => ({ ok: true, compacted: true, result });
const expectCallContaining = (mock: unknown, expected: unknown) =>
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(expected));
const staleBinding = { ok: false, compacted: false, reason: "thread not found: thread-1" };
const resumeState = (ids: Record<string, string>, claudeCliSessionId?: string) => ({
  cliSessionIds: ids,
  cliSessionBindings: Object.fromEntries(
    Object.entries(ids).map(([provider, sessionId]) => [provider, { sessionId }]),
  ),
  ...(claudeCliSessionId ? { claudeCliSessionId } : {}),
});

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;
  type ScenarioOptions = Omit<Parameters<typeof prepare>[0], "tmpDir" | "suffix"> & {
    compact?: ContextEngine["compact"];
  };
  const prepareScenario = async (suffix: string, { compact, ...params }: ScenarioOptions = {}) => {
    const scenario = await prepare({
      tmpDir,
      suffix,
      ...params,
      contextEngine: compact
        ? (calls) => ({
            ...buildContextEngine({ compactCalls: calls }),
            compact: async (input) => {
              calls.push(input);
              return compact(input);
            },
          })
        : params.contextEngine,
    });
    return {
      ...scenario,
      calls: scenario.compactCalls,
      record: scenario.recordCliCompactionInStore,
    };
  };
  const prepareHarness = async (
    suffix: string,
    compact: NativeCompaction,
    params: ScenarioOptions = {},
  ) => {
    const nativeCompact = vi.fn(compact);
    const scenario = await prepareScenario(suffix, {
      provider: "codex",
      model: "gpt-5.5",
      ...params,
      sessionEntry: { agentHarnessId: "codex", ...params.sessionEntry },
      deps: { ...params.deps, maybeCompactAgentHarnessSession: nativeCompact },
    });
    return { ...scenario, nativeCompact };
  };
  const prepareSuccessor = async (
    suffix: string,
    result: Parameters<typeof prepareContextSuccessorScenario>[0]["result"],
  ) => {
    const scenario = await prepareContextSuccessorScenario({ tmpDir, suffix, result });
    return { ...scenario, record: scenario.recordCliCompactionInStore };
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
    setCliCompactionTestDeps({
      resolveCliBackendConfig: () => null,
      acquirePreparedModelRuntime: async (input) => createPreparedRuntimeLease(input),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    await closeOpenClawAgentDatabasesAsync(tmpDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(["context", "native", "fallback", "failure", "stale", "abort-tail"] as const)(
    "retains its resolved engine until work and cleanup settle (%s)",
    async (mode) => {
      const abortTail = mode === "abort-tail";
      const retired = createDeferred();
      const retire = vi.fn(() => retired.resolve());
      const registry = createEmptyPluginRegistry();
      const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
      resources.attach(registry);
      resources.register("fixture", { id: "resource", dispose: retire });
      const compactStarted = createDeferred();
      const compactGate = createDeferred();
      const cleanupStarted = createDeferred();
      const cleanupGate = createDeferred();
      const cleanupFile = path.join(tmpDir, `owned-${mode}-cleanup.txt`);
      const controller = new AbortController();
      const staleError = new Error("compaction owner retired");
      const calls: CompactParams[] = [];
      const dispose = vi.fn(async () => {
        cleanupStarted.resolve();
        await cleanupGate.promise;
        if (!abortTail) {
          await fs.writeFile(cleanupFile, "disposed", { signal: getAsyncWorkSignal() });
        }
        if (mode === "failure") {
          throw new Error("cleanup failed too");
        }
      });
      const raw = {
        ...buildContextEngine({ compactCalls: calls }),
        dispose,
        ...(abortTail
          ? {
              compact: async () => {
                compactStarted.resolve();
                await compactGate.promise;
                expect(retire).not.toHaveBeenCalled();
                return { ok: false, compacted: false, reason: "aborted" };
              },
            }
          : {}),
      };
      registerContextEngineInRegistry(registry, "legacy", () => raw, "core");
      let engine: ContextEngine | undefined;
      const scenario = await prepareScenario(`owned-${mode}`, {
        provider: abortTail ? "claude-cli" : "github-copilot",
        sessionEntry: mode === "native" || mode === "fallback" ? { agentHarnessId: "copilot" } : {},
        maintenance: async () => {
          expect(retire).not.toHaveBeenCalled();
          if (mode === "failure") {
            throw new Error("maintenance failed");
          }
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        },
        deps: {
          ensureContextEnginesInitialized: vi.fn(),
          resolveContextEngine: async (cfg, options) => {
            engine = await withPluginRuntimeRegistryScope(registry, () =>
              resolveContextEngineFromRegistry(cfg, options),
            );
            if (mode === "stale") {
              controller.abort(staleError);
            }
            return engine;
          },
          maybeCompactAgentHarnessSession: async () => {
            expect(retire).not.toHaveBeenCalled();
            return mode === "fallback"
              ? {
                  ok: false,
                  compacted: false,
                  reason: "unsupported",
                  failure: { reason: "unsupported_harness_compaction" },
                }
              : { ok: true, compacted: true };
          },
        },
      });
      const result = scenario.run({ abortSignal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        if (abortTail) {
          await compactStarted.promise;
          controller.abort(new Error("compaction cancelled"));
          expect(await result).toEqual(
            expect.objectContaining({ message: expect.stringContaining("compaction cancelled") }),
          );
          await resources.release();
          expect(dispose).not.toHaveBeenCalled();
          expect(retire).not.toHaveBeenCalled();
          compactGate.resolve();
          await cleanupStarted.promise;
        } else {
          expect(
            await Promise.race([
              cleanupStarted.promise.then(() => "cleanup"),
              result.then(() => "returned"),
            ]),
          ).toBe("cleanup");
          await resources.release();
        }
        expect(retire).not.toHaveBeenCalled();
        cleanupGate.resolve();
        const error = await result;
        if (!abortTail) {
          if (mode === "failure") {
            expect(error).toEqual(new Error("maintenance failed"));
          } else {
            expect(error).toBe(mode === "stale" ? staleError : undefined);
          }
          expect(calls).toHaveLength(mode === "native" || mode === "stale" ? 0 : 1);
          expect(await fs.readFile(cleanupFile, "utf8")).toBe("disposed");
        }
        if (abortTail) {
          await retired.promise;
        }
        expect(retire).toHaveBeenCalledTimes(1);
      } finally {
        compactGate.resolve();
        cleanupGate.resolve();
        await result;
        if (abortTail) {
          await engine?.dispose?.();
        } else {
          await engine?.dispose?.().catch(() => {});
        }
        await resources.release();
      }
    },
  );

  it("accepts no compactable entries only from a successful compaction result", async () => {
    let result = { ok: true, compacted: false, reason: "no real conversation messages" };
    const scenario = await prepareScenario("no-compactable-entries", {
      provider: "test-provider",
      model: "test-model",
      compact: async () => result,
      deps: {
        openSessionManager: async () =>
          ({ getBranch: () => [], buildSessionContext: () => ({ messages: [] }) }) as never,
      },
    });
    const run = (ok: boolean, reason = "no real conversation messages", compacted = false) => {
      result = { ok, compacted, reason };
      return scenario.run();
    };

    await expect(run(true)).resolves.toBe(scenario.sessionEntry);
    await expect(run(false)).rejects.toThrow(
      "CLI transcript compaction failed for test-provider/test-model: no real conversation messages",
    );
    await expect(run(false, "already under target")).resolves.toBe(scenario.sessionEntry);
    await expect(run(false, "contradictory result", true)).rejects.toThrow(
      "CLI transcript compaction failed for test-provider/test-model: contradictory result",
    );
  });

  it.each(["admitted", "current"] as const)(
    "refreshes the CLI compaction budget with the %s plugin generation",
    async (source) => {
      const pluginRoot = path.join(tmpDir, "settings-bundle");
      await fs.mkdir(pluginRoot);
      const settingsFile = path.join(pluginRoot, "settings.json");
      const plugin = {
        id: "settings-bundle",
        rootDir: pluginRoot,
        format: "bundle" as const,
        settingsFiles: ["settings.json"],
      };
      const createSnapshot = (cache: ReturnType<typeof createPluginCache>) =>
        withPluginCache(cache, () => createPluginMetadataSnapshotFixture({ plugins: [plugin] }));
      await using initialCache = createPluginCache();
      await using replacementCache = createPluginCache();
      await fs.writeFile(settingsFile, JSON.stringify({ compaction: { reserveTokens: 20_000 } }));
      const scenario = await prepareScenario(`settings-${source}`, {
        cfg: { plugins: { entries: { "settings-bundle": { enabled: true } } } },
        sessionEntry: { contextTokens: 128_000, totalTokens: 100_000 },
        deps: {
          createPreparedEmbeddedAgentSettingsManager,
          shouldPreemptivelyCompactBeforePrompt,
          ensureContextEnginesInitialized: vi.fn(),
        },
      });
      const run = (snapshot: ReturnType<typeof createSnapshot>) =>
        source === "admitted"
          ? scenario.run({
              pluginGeneration: {
                remoteCatalog: null,
                configuredCatalogEntries: [],
                inlineProviderModels: [],
                pluginMetadataSnapshot: snapshot,
              },
            })
          : withPluginMetadataSnapshotScope(snapshot, () => scenario.run(), {
              trustConfigIdentity: true,
            });
      try {
        const initial = createSnapshot(initialCache);
        await run(initial);
        expect(scenario.calls).toHaveLength(0);
        await fs.writeFile(settingsFile, JSON.stringify({ compaction: { reserveTokens: 32_000 } }));
        await run(initial);
        expect(scenario.calls).toHaveLength(0);
        await run(createSnapshot(replacementCache));
        expect(scenario.calls).toHaveLength(1);
        expect(scenario.calls[0]?.currentTokenCount).toBe(100_000);
      } finally {
        clearPreparedEmbeddedAgentSettings([scenario.sessionId]);
      }
    },
  );

  it("records context-engine compaction successor session targets", async () => {
    const successorSessionId = "session-cli-rotated";
    const record = vi.fn(recordCliCompactionInStoreImpl);
    const taskCwd = path.join(tmpDir, "task-repo");
    await fs.mkdir(taskCwd, { recursive: true });
    const settingsCwds: string[] = [];
    const scenario = await prepareScenario("cli-rotates", {
      cwd: taskCwd,
      sessionEntry: resumeState(
        { codex: "stale-cli-session", "claude-cli": "stale-claude-session" },
        "stale-claude-session",
      ),
      compact: async (compactParams) =>
        successfulCompaction({
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
          sessionId: successorSessionId,
          sessionTarget: {
            sessionKey: "agent:main:cli-rotates",
            storePath: path.join(tmpDir, "cli-rotates.sqlite"),
          },
        }),
      recordCliCompactionInStore: record,
      deps: {
        createPreparedEmbeddedAgentSettingsManager: (params) => {
          settingsCwds.push(params.cwd);
          return defaultSettingsManager();
        },
      },
    });
    const { calls, maintenance, sessionId, sessionKey, storePath } = scenario;
    const updatedEntry = await scenario.run();

    expect(calls[0]?.runtimeContext?.workspaceDir).toBe(tmpDir);
    expect(calls[0]?.runtimeContext?.cwd).toBe(taskCwd);
    expect(settingsCwds).toEqual([taskCwd]);
    expect(calls[0]?.sessionTarget).toEqual({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
    });
    expectCallContaining(maintenance, {
      sessionId: successorSessionId,
      sessionFile: sessionKey,
    });
    expectCallContaining(record, {
      compactionKind: "context-engine",
      expectedSession: expect.objectContaining({ sessionId: successorSessionId }),
      tokensAfter: 100,
    });
    expect(updatedEntry?.cliSessionBindings).toBeUndefined();
    expect(updatedEntry?.cliSessionIds).toBeUndefined();
    expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("preserves deprecated SQLite-marker successors during CLI maintenance", async () => {
    const successorId = "session-cli-marker-successor";
    const scenario = await prepareSuccessor("marker", ({ storePath }) =>
      successfulCompaction({
        tokensBefore: 950,
        tokensAfter: 100,
        sessionId: successorId,
        sessionFile: `sqlite:main:${successorId}:${storePath}`,
      }),
    );

    await scenario.run();

    expectCallContaining(scenario.maintenance, {
      sessionFile: `sqlite:main:${successorId}:${scenario.storePath}`,
      sessionId: successorId,
      sessionTarget: {
        agentId: "main",
        sessionId: successorId,
        sessionKey: scenario.sessionKey,
        storePath: scenario.storePath,
      },
    });
    expectCallContaining(scenario.record, {
      expectedSession: expect.objectContaining({ sessionId: successorId }),
    });
  });

  it("rejects an engine that changes the host row before successor acceptance", async () => {
    const successorId = "session-cli-key-successor";
    const scenario = await prepareSuccessor("session-key", async ({ sessionKey, storePath }) => {
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: successorId, updatedAt: Date.now() },
      );
      return successfulCompaction({
        tokensBefore: 950,
        sessionId: successorId,
        sessionFile: sessionKey,
      });
    });

    await expect(scenario.run()).rejects.toThrow();
    expect(scenario.maintenance).not.toHaveBeenCalled();
    expect(scenario.record).not.toHaveBeenCalled();
  });

  it.each([
    { label: "conflicting ids", override: () => ({}), reportedId: "reported-successor" },
    { label: "agent", override: () => ({ agentId: "other" }) },
    { label: "session key", override: () => ({ sessionKey: "agent:main:other" }) },
    {
      label: "store",
      override: () => ({ storePath: path.join(tmpDir, "other-openclaw-sessions.sqlite") }),
    },
  ])("rejects a CLI successor with invalid $label", async ({ label, override, reportedId }) => {
    const scenario = await prepareSuccessor(
      label.replaceAll(" ", "-"),
      ({ sessionKey, storePath }) =>
        successfulCompaction({
          tokensBefore: 950,
          ...(reportedId ? { sessionId: reportedId } : {}),
          sessionTarget: {
            agentId: "main",
            sessionId: "outside-successor",
            sessionKey,
            storePath,
            ...override(),
          },
        }),
    );
    await expect(scenario.run()).rejects.toThrow(
      reportedId
        ? "successor identity is inconsistent"
        : "successor target changed the active session binding",
    );
  });

  it("ignores an unversioned fresh total on the first upgraded turn", async () => {
    const scenario = await prepareScenario("legacy-unversioned-total", {
      sessionEntry: { totalTokens: 950, totalTokensFresh: true, totalTokensVersion: undefined },
    });
    expect(await scenario.run()).toBe(scenario.sessionEntry);
    expect(scenario.calls).toEqual([]);
  });

  it("treats already-compacted CLI transcript compaction as a no-op", async () => {
    const scenario = await prepareScenario("qwen-already-compacted", {
      provider: "ollama",
      model: "qwen3:14b",
      compact: async () => {
        throw new Error("Already compacted");
      },
    });
    expect(await scenario.run()).toBe(scenario.sessionEntry);
    expect(scenario.calls).toHaveLength(1);
    expect(scenario.maintenance).not.toHaveBeenCalled();
    expect(scenario.record).not.toHaveBeenCalled();
  });

  it.each([
    { suffix: "codex", ownsNative: false, ownsEngine: false, locked: true },
    { suffix: "codex-with-ownership", ownsNative: true, ownsEngine: false, locked: false },
    { suffix: "codex-owned-engine", ownsNative: false, ownsEngine: true, locked: false },
  ])(
    "routes native compaction without accepting native result ids as host successors ($suffix)",
    async ({ suffix, ownsNative, ownsEngine, locked }) => {
      const provider = ownsEngine ? "codex" : "openai";
      const authProfileId = locked ? "github-copilot:work" : undefined;
      const tokensAfter = ownsEngine ? 42 : 100;
      const selection = { agentHarnessId: "codex", modelSelectionLocked: locked, authProfileId };
      const calls: CompactParams[] = [];
      const contextEngine = {
        ...buildContextEngine({ compactCalls: calls }),
        ...(ownsEngine
          ? { info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true } }
          : {}),
      };
      const resolveContextEngine = vi.fn(async () => contextEngine);
      const lease = createPreparedRuntimeLease({
        config: {},
        agentId: "main",
        agentDir: tmpDir,
        workspaceDir: tmpDir,
      });
      const pluginGeneration = lease.pluginGeneration;
      const acquirePreparedModelRuntime = vi.fn<
        NonNullable<CliCompactionTestDeps["acquirePreparedModelRuntime"]>
      >(async (_input, options) => {
        expect(options?.pluginGeneration).toBe(pluginGeneration);
        return lease;
      });
      const ensureHarness = vi.fn(async () => undefined);
      const guard = vi.fn(() => ({ supported: true, disabled: false }));
      const record = vi.fn(async () => ({
        sessionId: `session-${suffix}`,
        updatedAt: Date.now(),
        compactionCount: 1,
      }));
      const nativeResult = successfulCompaction({
        tokensBefore: 950,
        tokensAfter,
        ...(ownsEngine
          ? {
              summary: "engine-owned",
              firstKeptEntryId: "entry-1",
              sessionId: "session-codex-owned-engine-rotated",
              sessionFile: path.join(tmpDir, "session-codex-owned-engine-rotated.jsonl"),
            }
          : {}),
      });
      const scenario = await prepareHarness(suffix, async () => nativeResult, {
        provider,
        sessionEntry: {
          modelSelectionLocked: locked,
          authProfileOverride: authProfileId,
          authProfileOverrideSource: locked ? "auto" : undefined,
        },
        recordCliCompactionInStore: record,
        deps: {
          resolveContextEngine,
          acquirePreparedModelRuntime,
          ensureSelectedAgentHarnessPlugin: ensureHarness,
          applyAgentAutoCompactionGuard: guard,
          resolveCliBackendConfig: () =>
            ownsNative
              ? {
                  id: "codex",
                  config: { command: "codex" },
                  bundleMcp: false,
                  ownsNativeCompaction: true,
                }
              : null,
        },
      });
      const { nativeCompact, sessionId, sessionKey } = scenario;
      const updatedEntry = await scenario.run({
        pluginGeneration,
        cliBackendId: ownsNative ? "codex" : undefined,
      });
      expect(resolveContextEngine).toHaveBeenCalledTimes(1);
      expectCallContaining(guard, { contextEngineInfo: contextEngine.info });
      expectCallContaining(ensureHarness, {
        provider,
        modelId: "gpt-5.5",
        sessionKey,
        agentHarnessRuntimeOverride: "codex",
        pluginRegistry: lease.snapshot.pluginRegistry,
      });
      expect(acquirePreparedModelRuntime).toHaveBeenCalledOnce();
      expect(guard.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
        nativeCompact.mock.invocationCallOrder[0] ?? 0,
      );
      expect(nativeCompact).toHaveBeenCalledTimes(1);
      const [nativeInput, nativeOptions] = nativeCompact.mock.calls[0] ?? [];
      expect(nativeInput?.contextEngine).toBe(contextEngine);
      expect(nativeInput).toMatchObject({
        sessionId,
        sessionKey,
        sessionFile: sessionKey,
        provider,
        model: "gpt-5.5",
        contextTokenBudget: 1_000,
        currentTokenCount: 950,
        ...selection,
        trigger: "budget",
        force: true,
      });
      expect(nativeInput?.contextEngineRuntimeContext).toMatchObject({
        ...selection,
        currentTokenCount: 950,
        tokenBudget: 1_000,
        trigger: "cli_native_budget",
      });
      expect(nativeOptions?.preparedModelRuntime).toBe(lease.snapshot);
      expect(lease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
      expect(calls).toHaveLength(0);
      expect(record).toHaveBeenCalledTimes(1);
      expectCallContaining(record, {
        compactionKind: "native-harness",
        sessionKey,
        tokensAfter,
        expectedSession: expect.objectContaining({ sessionId }),
      });
      expect(updatedEntry?.compactionCount).toBe(1);
    },
  );

  it("ignores stale native harness ids when the active provider no longer matches", async () => {
    const nativeCompact = vi.fn();
    const scenario = await prepareScenario("openclaw-after-codex", {
      provider: "openclaw",
      model: "sonnet-4.6",
      sessionEntry: { agentHarnessId: "codex" },
      deps: { maybeCompactAgentHarnessSession: nativeCompact as never },
    });
    const { calls, sessionEntry, sessionKey } = scenario;
    await scenario.run();

    expect([nativeCompact.mock.calls.length, calls.length]).toEqual([0, 1]);

    const lockedEntry: SessionEntry = { ...sessionEntry, modelSelectionLocked: true };
    await expect(
      scenario.run({ sessionEntry: lockedEntry, sessionStore: { [sessionKey]: lockedEntry } }),
    ).rejects.toThrow("CLI compaction cannot replace a model-locked native harness runtime");
    expect([nativeCompact.mock.calls.length, calls.length]).toEqual([0, 1]);
  });

  it.each([
    { initialHarness: "copilot", updatedHarness: "other", nativeCalls: 1, contextCalls: 0 },
    { initialHarness: "other", updatedHarness: "copilot", nativeCalls: 0, contextCalls: 1 },
  ])(
    "keeps the initial compaction route when the harness changes from $initialHarness to $updatedHarness during engine resolution",
    async ({ initialHarness, updatedHarness, nativeCalls, contextCalls }) => {
      const nativeCompact = vi.fn<NativeCompaction>(async () => ({ ok: true, compacted: true }));
      const scenario = await prepareScenario(`harness-change-${initialHarness}`, {
        provider: "github-copilot",
        sessionEntry: { agentHarnessId: initialHarness },
        deps: {
          resolveContextEngine: async (): Promise<ContextEngine> => {
            scenario.sessionEntry.agentHarnessId = updatedHarness;
            return scenario.contextEngine;
          },
          maybeCompactAgentHarnessSession: nativeCompact,
        },
      });

      const updatedEntry = await scenario.run();

      expect(scenario.sessionEntry.agentHarnessId).toBe(updatedHarness);
      expect(nativeCompact).toHaveBeenCalledTimes(nativeCalls);
      expect(scenario.calls).toHaveLength(contextCalls);
      expect(updatedEntry?.compactionCount).toBe(1);
    },
  );

  it("skips context-engine fallback when Codex owns automatic compaction", async () => {
    const scenario = await prepareHarness("codex-native-auto-compaction", async () => ({
      ok: true,
      compacted: false,
      reason: "codex app-server owns automatic compaction",
      result: { summary: "", firstKeptEntryId: "", tokensBefore: 950 },
    }));
    const { nativeCompact, calls, record, sessionEntry, sessionKey, sessionStore } = scenario;
    const result = await scenario.run();

    // Codex owns automatic compaction; the ownership skip must not fall back to
    // context-engine compaction (OAuth-only sessions have no direct API key).
    expect(nativeCompact).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
    expect(result).toBe(sessionEntry);

    const lockedEntry: SessionEntry = { ...sessionEntry, modelSelectionLocked: true };
    sessionStore[sessionKey] = lockedEntry;
    const lockedResult = await scenario.run({ sessionEntry: lockedEntry });

    expect(nativeCompact).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
    const lockedNativeCall = nativeCompact.mock.calls[1]?.[0];
    expect(lockedNativeCall).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      contextEngineRuntimeContext: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        provider: "codex",
        model: "gpt-5.5",
      }),
    });
    expect(lockedResult).toBe(lockedEntry);
  });

  it("does not fall back when native harness compaction returns no result", async () => {
    const scenario = await prepareHarness("codex-native-empty", async () => undefined);

    await expect(scenario.run()).rejects.toThrow(
      "CLI native harness compaction failed for codex/gpt-5.5: native harness compaction did not reduce context",
    );
    expect(scenario.calls).toHaveLength(0);
  });

  it("clears stale Codex native binding when context-engine fallback is below target", async () => {
    const scenario = await prepareHarness(
      "codex-stale-binding-under-target",
      async () => ({ ...staleBinding, failure: { reason: "stale_thread_binding" } }),
      {
        sessionEntry: resumeState({ codex: "thread-1" }),
        compact: async () => ({ ok: true, compacted: false, reason: "already under target" }),
      },
    );
    const { nativeCompact, calls, maintenance, record, sessionKey, sessionStore } = scenario;
    const updatedEntry = await scenario.run();

    expect(nativeCompact).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(maintenance).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(updatedEntry?.compactionCount).toBeUndefined();
    expect(updatedEntry?.cliSessionBindings?.codex).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.codex).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionBindings?.codex).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.codex).toBeUndefined();
  });

  it("keeps successful context-engine fallback when post-compaction maintenance fails", async () => {
    const maintenance = vi.fn(async () => {
      throw new Error("maintenance rotated stale binding");
    });
    const scenario = await prepareHarness(
      "codex-stale-maintenance",
      async () => ({ ...staleBinding }),
      { maintenance },
    );
    const { calls, record, sessionKey } = scenario;
    const updatedEntry = await scenario.run();

    expect(calls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expectCallContaining(record, { sessionKey });
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("initializes built-in context engines before constructing CLI compaction engine", async () => {
    const calls: string[] = [];
    const registry = createEmptyPluginRegistry();
    const scenario = await prepareScenario("cli-init", {
      sessionEntry: { sessionFile: undefined },
      deps: {
        ensureContextEnginesInitialized: async () => {
          calls.push("ensure");
          registerContextEngineInRegistry(
            registry,
            "legacy",
            () => {
              calls.push("factory");
              return buildContextEngine({ compactCalls: [] });
            },
            "core",
          );
        },
        resolveContextEngine: (cfg, options) =>
          withPluginRuntimeRegistryScope(registry, () =>
            resolveContextEngineFromRegistry(cfg, options),
          ),
      },
    });
    await scenario.run();

    expect(calls).toEqual(["ensure", "factory"]);
  });

  it("bounds a hung CLI context-engine compaction and leaves resume state intact", async () => {
    const compactStarted = createDeferred();
    const compactGate = createDeferred();
    const disposed = createDeferred();
    const scenario = await prepareScenario("cli-timeout", {
      cfg: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } } as OpenClawConfig,
      sessionEntry: resumeState({ "claude-cli": "claude-session" }, "claude-session"),
      contextEngine: (calls) => ({
        ...buildContextEngine({ compactCalls: calls }),
        async compact(compactParams) {
          calls.push(compactParams);
          compactStarted.resolve();
          await compactGate.promise;
          return { ok: false, compacted: false };
        },
        async dispose() {
          disposed.resolve();
        },
      }),
    });
    const { calls, maintenance, record, sessionKey, sessionStore } = scenario;

    vi.useFakeTimers();
    const pending = scenario.run();

    const rejection = expect(pending).rejects.toThrow(
      "CLI transcript compaction failed for claude-cli/opus: Compaction timed out",
    );
    try {
      await compactStarted.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;

      expect(calls).toHaveLength(1);
      expect(calls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(calls[0]?.abortSignal?.aborted).toBe(true);
      expect(maintenance).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
        "claude-session",
      );
    } finally {
      compactGate.resolve();
      await pending.catch(() => undefined);
      await disposed.promise;
      vi.useRealTimers();
    }
  });

  it("preserves google-gemini-cli native history and resume binding under compaction pressure", async () => {
    const entry = cliCompactionBackendEntrypoints[1];
    const { provider, pluginId } = entry;
    const bundled = path.join(tmpDir, "bundled");
    const pluginRoot = path.join(bundled, pluginId);
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.copyFile(
      new URL(`../../../extensions/${pluginId}/openclaw.plugin.json`, import.meta.url),
      path.join(pluginRoot, "openclaw.plugin.json"),
    );
    await fs.writeFile(
      path.join(pluginRoot, "setup-api.mjs"),
      `export { default } from ${JSON.stringify(resolveRuntimeWorkerUrl(entry).href)};`,
    );
    await fs.copyFile(path.join(pluginRoot, "setup-api.mjs"), path.join(pluginRoot, "index.mjs"));
    const backend = withEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundled }, () =>
      resolveCliBackendConfig(provider),
    );
    expect(backend).not.toBeNull();
    const nativeCompact = vi.fn();
    const scenario = await prepareScenario(`${provider}-owns-compaction`, {
      provider,
      sessionEntry: {
        cliSessionBindings: { [provider]: { sessionId: "native-session" } },
      },
      deps: {
        maybeCompactAgentHarnessSession: nativeCompact as never,
        resolveCliBackendConfig: () => backend,
      },
    });
    const { calls, record, sessionEntry } = scenario;
    const updatedEntry = await scenario.run();

    expect(nativeCompact).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
    expect(updatedEntry?.cliSessionBindings?.[provider]?.sessionId).toBe("native-session");
  });

  it("does not compact reset-discarded tool output in the post-turn lifecycle", async () => {
    const manager = SessionManager.fromEntries([
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-reset-lifecycle-proof",
        timestamp: new Date(0).toISOString(),
        cwd: tmpDir,
      },
    ]);
    const userId = manager.appendMessage({ role: "user", content: "kept question", timestamp: 1 });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(20_000) }],
      isError: false,
      timestamp: 2,
    });
    manager.appendMessage(
      makeAssistantMessageFixture({
        provider: "test-provider",
        content: [{ type: "text", text: "kept answer" }],
        usage: { ...ZERO_USAGE_FIXTURE, input: 1, output: 1, totalTokens: 2 },
        stopReason: "stop",
        errorMessage: undefined,
        timestamp: 3,
      }),
    );
    manager.appendResetBoundary("new", userId);
    manager.appendMessage({ role: "user", content: "new turn after reset", timestamp: 4 });
    const record = vi.fn(async (): Promise<SessionEntry> => scenario.sessionEntry);
    const scenario = await prepareScenario("reset-lifecycle-proof", {
      sessionEntry: { sessionFile: undefined, contextTokens: 4_096, totalTokens: 400 },
      recordCliCompactionInStore: record,
      deps: {
        shouldPreemptivelyCompactBeforePrompt,
        openSessionManager: async () => manager,
        createPreparedEmbeddedAgentSettingsManager: () =>
          SettingsManager.inMemory({ compaction: { reserveTokens: 512, keepRecentTokens: 0 } }),
      },
    });
    expect(await scenario.run()).toBe(scenario.sessionEntry);
    expect(scenario.calls).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });
});
