import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as contextEngineInit from "../../context-engine/init.js";
import * as contextEngineRegistry from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import * as agentProjectSettings from "../agent-project-settings.js";
import * as agentSettings from "../agent-settings.js";
import * as cliBackends from "../cli-backends.js";
import * as contextEngineMaintenance from "../embedded-agent-runner/context-engine-maintenance.js";
import { createModelGenerationFixture } from "../embedded-agent-runner/model.generation-scope.test-support.js";
import * as preemptiveCompaction from "../embedded-agent-runner/run/preemptive-compaction.js";
import * as toolResultTruncation from "../embedded-agent-runner/tool-result-truncation.js";
import * as harnessCompaction from "../harness/compaction.js";
import * as harnessRuntimePlugin from "../harness/runtime-plugin.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { runCliTurnCompactionLifecycle } from "./cli-compaction.js";
import * as sessionStoreModule from "./session-store.js";

export type CliCompactionTestDeps = {
  [Key in keyof typeof installSpies]?: Parameters<
    ReturnType<(typeof installSpies)[Key]>["mockImplementation"]
  >[0];
};
type CliCompactionParams = Parameters<typeof runCliTurnCompactionLifecycle>[0];
type CompactParams = Parameters<ContextEngine["compact"]>[0];

export const resolveContextEngineFromRegistry = contextEngineRegistry.resolveContextEngine;
export const resolveCliBackendConfig = cliBackends.resolveCliBackendConfig;
export const recordCliCompactionInStoreImpl = sessionStoreModule.recordCliCompactionInStore;

const installSpies = {
  openSessionManager: () => vi.spyOn(SessionManager, "openAsync"),
  ensureContextEnginesInitialized: () =>
    vi.spyOn(contextEngineInit, "ensureContextEnginesInitialized"),
  resolveContextEngine: () => vi.spyOn(contextEngineRegistry, "resolveContextEngine"),
  createPreparedEmbeddedAgentSettingsManager: () =>
    vi.spyOn(agentProjectSettings, "createPreparedEmbeddedAgentSettingsManager"),
  applyAgentAutoCompactionGuard: () => vi.spyOn(agentSettings, "applyAgentAutoCompactionGuard"),
  shouldPreemptivelyCompactBeforePrompt: () =>
    vi.spyOn(preemptiveCompaction, "shouldPreemptivelyCompactBeforePrompt"),
  resolveLiveToolResultMaxChars: () =>
    vi.spyOn(toolResultTruncation, "resolveLiveToolResultMaxChars"),
  runContextEngineMaintenance: () =>
    vi.spyOn(contextEngineMaintenance, "runContextEngineMaintenance"),
  acquirePreparedModelRuntime: () =>
    vi.spyOn(preparedModelRuntime, "acquireAgentRunPreparedModelRuntime"),
  ensureSelectedAgentHarnessPlugin: () =>
    vi.spyOn(harnessRuntimePlugin, "ensureSelectedAgentHarnessPlugin"),
  maybeCompactAgentHarnessSession: () =>
    vi.spyOn(harnessCompaction, "maybeCompactAgentHarnessSession"),
  resolveCliBackendConfig: () => vi.spyOn(cliBackends, "resolveCliBackendConfig"),
  recordCliCompactionInStore: () => vi.spyOn(sessionStoreModule, "recordCliCompactionInStore"),
};

export function setCliCompactionTestDeps(overrides: CliCompactionTestDeps): void {
  const replacements: Record<string, unknown> = overrides;
  for (const [name, install] of Object.entries(installSpies)) {
    const replacement = replacements[name];
    if (typeof replacement === "function") {
      install().mockImplementation((...args: unknown[]) => replacement(...args));
    }
  }
}

export function buildContextEngine(params: {
  compactCalls: CompactParams[];
  compact?: ContextEngine["compact"];
}): ContextEngine {
  return {
    info: { id: "legacy", name: "Legacy Context Engine" },
    ingest: async () => ({ ingested: false }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      if (params.compact) {
        return params.compact(compactParams);
      }
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
}

const systemCompactionHost = {
  sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined },
} satisfies Parameters<typeof runCliTurnCompactionLifecycle>[1];

export function createPreparedRuntimeLease(input: {
  config: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  workspaceDir?: string;
}) {
  const prepared = createModelGenerationFixture({
    config: input.config,
    label: "cli",
    agentDir: input.agentDir,
    workspaceDir: expectDefined(input.workspaceDir, "compaction fixture workspace"),
  });
  return {
    snapshot: {
      ...prepared.preparedModelRuntime,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
    pluginGeneration: {
      remoteCatalog: null,
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: prepared.metadataSnapshot,
      pluginRegistry: prepared.pluginRegistry,
    },
    run: <T>(run: () => T): T => run(),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

export const defaultSettingsManager = () =>
  SettingsManager.inMemory({ compaction: { reserveTokens: 200, keepRecentTokens: 0 } });

export async function prepareCompactionScenario(params: {
  tmpDir: string;
  suffix: string;
  provider?: string;
  model?: string;
  sessionEntry?: Partial<SessionEntry>;
  cfg?: OpenClawConfig;
  cwd?: string;
  compact?: ContextEngine["compact"];
  contextEngine?: (compactCalls: CompactParams[]) => ContextEngine;
  maintenance?: CliCompactionTestDeps["runContextEngineMaintenance"];
  recordCliCompactionInStore?: CliCompactionTestDeps["recordCliCompactionInStore"];
  deps?: CliCompactionTestDeps;
}) {
  const sessionKey = `agent:main:${params.suffix}`;
  const sessionId = `session-${params.suffix}`;
  const transcriptFile = path.join(params.tmpDir, `${params.suffix}.jsonl`);
  const storePath = path.join(params.tmpDir, `${params.suffix}.sqlite`);
  const sessionEntry = {
    sessionId,
    updatedAt: Date.now(),
    sessionFile: transcriptFile,
    contextTokens: 1_000,
    totalTokens: 950,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    ...params.sessionEntry,
  };
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
  const session = { sessionEntry, sessionId, sessionKey, sessionStore, storePath };
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);

  const compactCalls: CompactParams[] = [];
  const contextEngine = params.compact
    ? buildContextEngine({ compactCalls, compact: params.compact })
    : (params.contextEngine?.(compactCalls) ?? buildContextEngine({ compactCalls }));
  const maintenance = vi.fn(
    params.maintenance ?? (async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
  );
  const recordCliCompactionInStore =
    params.recordCliCompactionInStore ?? vi.fn(recordCliCompactionInStoreImpl);
  setCliCompactionTestDeps({
    resolveContextEngine: async (_cfg, options) => {
      await options?.initialize?.();
      return contextEngine;
    },
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
    createPreparedEmbeddedAgentSettingsManager: defaultSettingsManager,
    shouldPreemptivelyCompactBeforePrompt: () => ({
      route: "fits",
      shouldCompact: false,
      estimatedPromptTokens: 600,
      promptBudgetBeforeReserve: 800,
      overflowTokens: 0,
      toolResultReducibleChars: 0,
      effectiveReserveTokens: 200,
    }),
    resolveLiveToolResultMaxChars: () => 20_000,
    runContextEngineMaintenance: maintenance,
    recordCliCompactionInStore,
    ...params.deps,
  });

  const runParams: CliCompactionParams = {
    cfg: params.cfg ?? {},
    ...session,
    sessionAgentId: "main",
    workspaceDir: params.tmpDir,
    cwd: params.cwd,
    agentDir: params.tmpDir,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
  };
  return {
    calls: compactCalls,
    record: recordCliCompactionInStore,
    compactCalls,
    contextEngine,
    maintenance,
    recordCliCompactionInStore,
    run: (overrides: Partial<CliCompactionParams> = {}) =>
      runCliTurnCompactionLifecycle({ ...runParams, ...overrides }, systemCompactionHost),
    ...session,
    transcriptFile,
  };
}
