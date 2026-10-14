import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
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
import * as cliSessionStore from "../cli-session-store.js";
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

export type CliCompactionTestDeps = Partial<{
  openSessionManager: typeof SessionManager.openAsync;
  ensureContextEnginesInitialized: typeof contextEngineInit.ensureContextEnginesInitialized;
  resolveContextEngine: typeof contextEngineRegistry.resolveContextEngine;
  createPreparedEmbeddedAgentSettingsManager: typeof agentProjectSettings.createPreparedEmbeddedAgentSettingsManager;
  applyAgentAutoCompactionGuard: typeof agentSettings.applyAgentAutoCompactionGuard;
  shouldPreemptivelyCompactBeforePrompt: typeof preemptiveCompaction.shouldPreemptivelyCompactBeforePrompt;
  resolveLiveToolResultMaxChars: typeof toolResultTruncation.resolveLiveToolResultMaxChars;
  runContextEngineMaintenance: typeof contextEngineMaintenance.runContextEngineMaintenance;
  acquirePreparedModelRuntime: typeof preparedModelRuntime.acquireAgentRunPreparedModelRuntime;
  ensureSelectedAgentHarnessPlugin: typeof harnessRuntimePlugin.ensureSelectedAgentHarnessPlugin;
  maybeCompactAgentHarnessSession: typeof harnessCompaction.maybeCompactAgentHarnessSession;
  clearCliSessionInStore: typeof cliSessionStore.clearCliSessionInStore;
  resolveCliBackendConfig: typeof cliBackends.resolveCliBackendConfig;
  recordCliCompactionInStore: typeof sessionStoreModule.recordCliCompactionInStore;
}>;
type CliCompactionParams = Parameters<typeof runCliTurnCompactionLifecycle>[0];
type CompactParams = Parameters<ContextEngine["compact"]>[0];

export const resolveContextEngineFromRegistry = contextEngineRegistry.resolveContextEngine;
export const resolveCliBackendConfig = cliBackends.resolveCliBackendConfig;
export const recordCliCompactionInStoreImpl = sessionStoreModule.recordCliCompactionInStore;

export function setCliCompactionTestDeps(overrides: CliCompactionTestDeps): void {
  if (overrides.openSessionManager) {
    vi.spyOn(SessionManager, "openAsync").mockImplementation(overrides.openSessionManager);
  }
  if (overrides.ensureContextEnginesInitialized) {
    vi.spyOn(contextEngineInit, "ensureContextEnginesInitialized").mockImplementation(
      overrides.ensureContextEnginesInitialized,
    );
  }
  if (overrides.resolveContextEngine) {
    vi.spyOn(contextEngineRegistry, "resolveContextEngine").mockImplementation(
      overrides.resolveContextEngine,
    );
  }
  if (overrides.createPreparedEmbeddedAgentSettingsManager) {
    vi.spyOn(agentProjectSettings, "createPreparedEmbeddedAgentSettingsManager").mockImplementation(
      overrides.createPreparedEmbeddedAgentSettingsManager,
    );
  }
  if (overrides.applyAgentAutoCompactionGuard) {
    vi.spyOn(agentSettings, "applyAgentAutoCompactionGuard").mockImplementation(
      overrides.applyAgentAutoCompactionGuard,
    );
  }
  if (overrides.shouldPreemptivelyCompactBeforePrompt) {
    vi.spyOn(preemptiveCompaction, "shouldPreemptivelyCompactBeforePrompt").mockImplementation(
      overrides.shouldPreemptivelyCompactBeforePrompt,
    );
  }
  if (overrides.resolveLiveToolResultMaxChars) {
    vi.spyOn(toolResultTruncation, "resolveLiveToolResultMaxChars").mockImplementation(
      overrides.resolveLiveToolResultMaxChars,
    );
  }
  if (overrides.runContextEngineMaintenance) {
    vi.spyOn(contextEngineMaintenance, "runContextEngineMaintenance").mockImplementation(
      overrides.runContextEngineMaintenance,
    );
  }
  if (overrides.acquirePreparedModelRuntime) {
    vi.spyOn(preparedModelRuntime, "acquireAgentRunPreparedModelRuntime").mockImplementation(
      overrides.acquirePreparedModelRuntime,
    );
  }
  if (overrides.ensureSelectedAgentHarnessPlugin) {
    vi.spyOn(harnessRuntimePlugin, "ensureSelectedAgentHarnessPlugin").mockImplementation(
      overrides.ensureSelectedAgentHarnessPlugin,
    );
  }
  if (overrides.maybeCompactAgentHarnessSession) {
    vi.spyOn(harnessCompaction, "maybeCompactAgentHarnessSession").mockImplementation(
      overrides.maybeCompactAgentHarnessSession,
    );
  }
  if (overrides.clearCliSessionInStore) {
    vi.spyOn(cliSessionStore, "clearCliSessionInStore").mockImplementation(
      overrides.clearCliSessionInStore,
    );
  }
  if (overrides.resolveCliBackendConfig) {
    vi.spyOn(cliBackends, "resolveCliBackendConfig").mockImplementation(
      overrides.resolveCliBackendConfig,
    );
  }
  if (overrides.recordCliCompactionInStore) {
    vi.spyOn(sessionStoreModule, "recordCliCompactionInStore").mockImplementation(
      overrides.recordCliCompactionInStore,
    );
  }
}

export function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
}): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Legacy Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
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

export const systemCompactionHost = {
  sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined },
} satisfies Parameters<typeof runCliTurnCompactionLifecycle>[1];

async function writeSessionFile(params: { sessionFile: string; sessionId: string }) {
  // The lifecycle compacts canonical OpenClaw session JSONL, so tests write the
  // same session/message envelope the real store appends.
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  await fs.writeFile(
    params.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: path.dirname(params.sessionFile),
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "old ask", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          timestamp: 2,
        },
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
}

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
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

export const defaultSettingsManager = () =>
  SettingsManager.inMemory({ compaction: { reserveTokens: 200, keepRecentTokens: 0 } });

const defaultPreemptiveCompaction = () => ({
  route: "fits" as const,
  shouldCompact: false,
  estimatedPromptTokens: 600,
  promptBudgetBeforeReserve: 800,
  overflowTokens: 0,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 200,
});

export async function prepareCompactionScenario(params: {
  tmpDir: string;
  suffix: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionEntry?: Partial<SessionEntry>;
  cfg?: OpenClawConfig;
  cwd?: string;
  contextEngine?: (compactCalls: CompactParams[]) => ContextEngine;
  maintenance?: CliCompactionTestDeps["runContextEngineMaintenance"];
  recordCliCompactionInStore?: CliCompactionTestDeps["recordCliCompactionInStore"];
  deps?: CliCompactionTestDeps;
}) {
  const sessionKey = params.sessionKey ?? `agent:main:${params.suffix}`;
  const sessionId = params.sessionId ?? `session-${params.suffix}`;
  const transcriptFile = path.join(params.tmpDir, `${params.suffix}.jsonl`);
  const storePath = path.join(params.tmpDir, `${params.suffix}.sqlite`);
  await writeSessionFile({ sessionFile: transcriptFile, sessionId });

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
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);

  const compactCalls: CompactParams[] = [];
  const contextEngine =
    params.contextEngine?.(compactCalls) ?? buildContextEngine({ compactCalls });
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
    shouldPreemptivelyCompactBeforePrompt: defaultPreemptiveCompaction,
    resolveLiveToolResultMaxChars: () => 20_000,
    runContextEngineMaintenance: maintenance,
    recordCliCompactionInStore,
    ...params.deps,
  });

  const runParams: CliCompactionParams = {
    cfg: params.cfg ?? ({} as OpenClawConfig),
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    sessionAgentId: "main",
    workspaceDir: params.tmpDir,
    cwd: params.cwd,
    agentDir: params.tmpDir,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
  };
  return {
    compactCalls,
    contextEngine,
    maintenance,
    recordCliCompactionInStore,
    run: (overrides: Partial<CliCompactionParams> = {}) =>
      runCliTurnCompactionLifecycle({ ...runParams, ...overrides }, systemCompactionHost),
    sessionEntry,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    transcriptFile,
  };
}

export async function prepareContextSuccessorScenario(params: {
  result: (target: {
    sessionKey: string;
    sessionId: string;
    storePath: string;
  }) =>
    | Awaited<ReturnType<ContextEngine["compact"]>>
    | Promise<Awaited<ReturnType<ContextEngine["compact"]>>>;
  suffix: string;
  tmpDir: string;
}) {
  return prepareCompactionScenario({
    suffix: `cli-successor-${params.suffix}`,
    tmpDir: params.tmpDir,
    contextEngine: () => ({
      ...buildContextEngine({ compactCalls: [] }),
      async compact() {
        const sessionKey = `agent:main:cli-successor-${params.suffix}`;
        const sessionId = `session-cli-successor-${params.suffix}`;
        const storePath = path.join(params.tmpDir, `cli-successor-${params.suffix}.sqlite`);
        return params.result({ sessionId, sessionKey, storePath });
      },
    }),
    recordCliCompactionInStore: vi.fn(
      async ({ sessionKey, sessionStore }) => sessionStore[sessionKey],
    ),
  });
}
