import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createModelGenerationFixture } from "../embedded-agent-runner/model.generation-scope.test-support.js";
import { runCliTurnCompactionLifecycle, setCliCompactionTestDeps } from "./cli-compaction.js";
import { recordCliCompactionInStore as recordCliCompactionInStoreImpl } from "./session-store.js";

type CliCompactionTestDeps = Parameters<typeof setCliCompactionTestDeps>[0];
type CliCompactionParams = Parameters<typeof runCliTurnCompactionLifecycle>[0];
type CompactParams = Parameters<ContextEngine["compact"]>[0];

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

export const defaultSettingsManager = async () => ({
  getCompactionReserveTokens: () => 200,
  getCompactionKeepRecentTokens: () => 0,
  applyOverrides: () => {},
});

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
