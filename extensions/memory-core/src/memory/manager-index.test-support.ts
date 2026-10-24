import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  EmbeddingInput,
  EmbeddingProviderCallOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  loadSqliteVecExtension,
  type MemoryExtraPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  requireNativeSqliteDatabase,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

type GetMemorySearchManager = typeof import("./index.js").getMemorySearchManager;
type ManagerConfig = Parameters<GetMemorySearchManager>[0]["cfg"];
type ManagerResult = Awaited<ReturnType<GetMemorySearchManager>>;

type ManagerIndexFixtureConfig = {
  extraPaths?: MemoryExtraPath[];
  sources?: Array<"memory" | "sessions">;
  sessionMemory?: boolean;
  rememberAcrossConversations?: boolean;
  provider?: string;
  fallback?: "none" | "gemini" | "fallback-provider";
  providerAliases?: NonNullable<NonNullable<ManagerConfig["models"]>["providers"]>;
  batchEnabled?: boolean;
  model?: string;
  outputDimensionality?: number;
  multimodal?: {
    enabled?: boolean;
    modalities?: Array<"image" | "audio" | "all">;
    maxFileBytes?: number;
  };
  vectorEnabled?: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
  cacheEnabled?: boolean;
  minScore?: number;
};

type ProviderCall = Pick<ManagerIndexFixtureConfig, "provider" | "model" | "outputDimensionality">;

type SessionTranscript = {
  messages: Array<{
    content: string;
    role: "assistant" | "user";
    senderIsOwner?: boolean;
    timestamp: number | string;
  }>;
  sessionId: string;
  sessionKey?: string;
};

const { providerState, resetProviderState } = vi.hoisted(() => {
  const defaults = () => ({
    beforeEmbedBatch: null as (() => Promise<void>) | null,
    beforeEmbedQuery: null as ((options?: EmbeddingProviderCallOptions) => Promise<void>) | null,
    embedQueryCalls: 0,
    embeddedQueryTexts: [] as string[],
    embedBatchCalls: 0,
    embeddedBatchTexts: [] as string[],
    embedBatchPermanentFailure: null as Error | null,
    embedBatchInputCalls: 0,
    embeddedBatchInputs: [] as EmbeddingInput[][],
    providerRuntimeBatchCalls: [] as string[][],
    providerRuntimeBatchGate: null as Promise<void> | null,
    providerRuntimeBatchEntered: null as
      | ((activeCalls: number, texts: readonly string[]) => void)
      | null,
    providerRuntimeBatchErrors: [] as unknown[],
    providerRuntimeBatchFailuresRemaining: 0,
    providerRuntimeActiveBatchCalls: 0,
    providerRuntimeMaxActiveBatchCalls: 0,
    providerCloseCalls: 0,
    providerCloseFailuresRemaining: 0,
    providerCloseFailure: new Error("provider close failed") as unknown,
    providerCreationFailure: null as string | null,
    providerNullResult: null as string | null,
    providerCloseGate: null as Promise<void> | null,
    providerInitGate: null as Promise<void> | null,
    providerCalls: [] as ProviderCall[],
    forceNoProvider: false,
  });
  const initialState = {
    ...defaults(),
    identityAlias: {
      provider: "identity-alias-test",
      canonicalModel: "hf:fixture/default-model.gguf",
      cacheModel: "/fixture/cache/default-model.gguf",
    },
  };
  return {
    providerState: initialState,
    resetProviderState: () => Object.assign(initialState, defaults()),
  };
});

vi.setConfig({ testTimeout: 240_000 });

afterAll(() => vi.resetConfig());

function createLocalWorkerExitError(): Error {
  return Object.assign(new Error("Local embedding worker exited unexpectedly (exit code 134)"), {
    code: "LOCAL_EMBEDDING_WORKER_EXITED",
    reason: "exit",
    exitCode: 134,
  });
}

vi.mock("./embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embeddings.js")>();
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    return ["alpha", "beta", "image", "audio"].map((token) => lower.split(token).length - 1);
  };
  const resolveFallbackModel = (providerId: string, fallbackSourceModel: string) =>
    providerId === "gemini" || providerId === "fallback-provider"
      ? `${providerId}-embed`
      : fallbackSourceModel;
  const aliasIdentity = () => {
    const { provider, canonicalModel, cacheModel } = providerState.identityAlias;
    const key = (model: string) => ({ provider, model });
    return {
      provider: { id: provider, model: canonicalModel },
      cacheKeyData: key(canonicalModel),
      aliases: [{ model: cacheModel, cacheKeyData: key(cacheModel) }],
    };
  };
  return {
    ...actual,
    resolveEmbeddingProviderFallbackModel: resolveFallbackModel,
    resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
      providerId === "local" ? "local" : "remote",
    resolveEmbeddingProviderIndexIdentity: (
      options: Parameters<typeof actual.resolveEmbeddingProviderIndexIdentity>[0],
    ) =>
      options.provider === providerState.identityAlias.provider
        ? aliasIdentity()
        : {
            provider: {
              id: options.config.models?.providers?.[options.provider]?.api ?? options.provider,
              model: options.model.trim() || resolveFallbackModel(options.provider, ""),
            },
          },
    createEmbeddingProvider: async (options: ProviderCall) => {
      providerState.providerCalls.push({
        provider: options.provider,
        model: options.model,
        outputDimensionality: options.outputDimensionality,
      });
      await providerState.providerInitGate;
      if (options.provider === providerState.providerCreationFailure) {
        throw new Error(`provider creation failed: ${options.provider}`);
      }
      if (options.provider === providerState.providerNullResult) {
        return {
          provider: null,
          requestedProvider: options.provider,
          providerUnavailableReason: `provider unavailable: ${options.provider}`,
        };
      }
      if (providerState.forceNoProvider) {
        return {
          provider: null,
          requestedProvider: options.provider ?? "auto",
          providerUnavailableReason: "No API key found for provider",
        };
      }
      const providerId =
        options.provider === "gemini" ||
        options.provider === "fallback-provider" ||
        options.provider === "batch-test" ||
        options.provider === "batch-wide-test" ||
        options.provider === providerState.identityAlias.provider ||
        options.provider === "ollama"
          ? options.provider
          : "mock";
      const requestedModel = options.model ?? "mock-embed";
      const model =
        providerId === providerState.identityAlias.provider &&
        (requestedModel === providerState.identityAlias.canonicalModel ||
          requestedModel === providerState.identityAlias.cacheModel)
          ? providerState.identityAlias.canonicalModel
          : requestedModel;
      const runtime =
        providerId === providerState.identityAlias.provider
          ? {
              id: providerId,
              cacheKeyData: aliasIdentity().cacheKeyData,
              indexIdentityAliases: aliasIdentity().aliases,
            }
          : providerId === "batch-test" || providerId === "batch-wide-test"
            ? {
                id: providerId,
                ...(providerId === "batch-wide-test" ? { sourceWideBatchEmbed: true } : {}),
                batchEmbed: async (batch: { chunks: Array<{ text: string }> }) => {
                  const texts = batch.chunks.map((chunk) => chunk.text);
                  providerState.providerRuntimeActiveBatchCalls += 1;
                  providerState.providerRuntimeMaxActiveBatchCalls = Math.max(
                    providerState.providerRuntimeMaxActiveBatchCalls,
                    providerState.providerRuntimeActiveBatchCalls,
                  );
                  try {
                    providerState.providerRuntimeBatchEntered?.(
                      providerState.providerRuntimeActiveBatchCalls,
                      texts,
                    );
                    await providerState.providerRuntimeBatchGate;
                    providerState.providerRuntimeBatchCalls.push(texts);
                    if (providerState.providerRuntimeBatchErrors.length > 0) {
                      throw providerState.providerRuntimeBatchErrors.shift();
                    }
                    if (providerState.providerRuntimeBatchFailuresRemaining > 0) {
                      providerState.providerRuntimeBatchFailuresRemaining -= 1;
                      throw new Error("provider runtime batch failed");
                    }
                    return texts.map(embedText);
                  } finally {
                    providerState.providerRuntimeActiveBatchCalls -= 1;
                  }
                },
              }
            : providerId === "gemini" || providerId === "fallback-provider"
              ? {
                  id: providerId,
                  cacheKeyData: {
                    provider: providerId,
                    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                    model,
                    outputDimensionality: options.outputDimensionality,
                    headers: [],
                  },
                }
              : undefined;
      return {
        requestedProvider: options.provider ?? "openai",
        provider: {
          id: providerId,
          model,
          close: async () => {
            providerState.providerCloseCalls += 1;
            await providerState.providerCloseGate;
            if (providerState.providerCloseFailuresRemaining > 0) {
              providerState.providerCloseFailuresRemaining -= 1;
              throw providerState.providerCloseFailure;
            }
          },
          embed: async (input: EmbeddingInput, callOptions?: EmbeddingProviderCallOptions) => {
            await providerState.beforeEmbedQuery?.(callOptions);
            const text = typeof input === "string" ? input : input.text;
            providerState.embedQueryCalls += 1;
            providerState.embeddedQueryTexts.push(text);
            return embedText(text);
          },
          embedBatch: async (inputs: EmbeddingInput[]) => {
            await providerState.beforeEmbedBatch?.();
            if (providerId === "gemini" || providerId === "fallback-provider") {
              const structuredInputs = inputs.filter(
                (input): input is Exclude<EmbeddingInput, string> =>
                  typeof input !== "string" && input.parts?.length !== undefined,
              );
              if (structuredInputs.length > 0) {
                providerState.embedBatchInputCalls += 1;
                providerState.embeddedBatchInputs.push(inputs);
                return structuredInputs.map((input) => {
                  const inlineData = input.parts?.find((part) => part.type === "inline-data");
                  if (inlineData?.type === "inline-data" && inlineData.data.length > 9000) {
                    throw new Error("payload too large");
                  }
                  const mimeType =
                    inlineData?.type === "inline-data" ? inlineData.mimeType : undefined;
                  if (mimeType?.startsWith("image/")) {
                    return [0, 0, 1, 0];
                  }
                  if (mimeType?.startsWith("audio/")) {
                    return [0, 0, 0, 1];
                  }
                  return embedText(input.text);
                });
              }
            }
            if (providerState.embedBatchPermanentFailure !== null) {
              throw providerState.embedBatchPermanentFailure;
            }
            const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
            providerState.embedBatchCalls += 1;
            providerState.embeddedBatchTexts.push(...texts);
            return texts.map(embedText);
          },
        },
        ...(runtime ? { runtime } : {}),
      };
    },
  };
});

export function createManagerIndexFixture(deps: {
  getMemorySearchManager: GetMemorySearchManager;
  closeAllMemorySearchManagers: typeof import("./index.js").closeAllMemorySearchManagers;
}) {
  const provider = Object.assign(providerState, { createLocalWorkerExitError });
  let state: OpenClawTestState;
  let workerState: OpenClawTestState | undefined;
  const managers = new Set<MemoryIndexManager>();

  const resetManager = async (manager: MemoryIndexManager): Promise<void> => {
    const db = memoryIndexFixtureWriter(manager);
    for (const table of [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_embedding_cache",
      "memory_index_chunks_fts",
      "memory_index_chunks_vec",
    ]) {
      const existingTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (existingTable?.name === table) {
        if (table === "memory_index_chunks_vec") {
          const loaded = await loadSqliteVecExtension({ db });
          if (!loaded.ok) {
            throw new Error(loaded.error);
          }
        }
        db.exec(`DELETE FROM ${table}`);
      }
    }
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = false;
    (manager as unknown as { sessionsDirtyFiles: Set<string> }).sessionsDirtyFiles.clear();
  };

  const createConfig = (params: ManagerIndexFixtureConfig): ManagerConfig => {
    const cfg = isolateMemoryManagerTestConfig({
      memory: {
        search: {
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
          model: params.model ?? "mock-embed",
          fallback: params.fallback,
          outputDimensionality: params.outputDimensionality,
          store: {
            fts: params.ftsTokenizer ? { tokenizer: params.ftsTokenizer } : undefined,
            vector: params.vectorEnabled !== undefined ? { enabled: params.vectorEnabled } : {},
          },
          remote: params.batchEnabled ? { batch: { enabled: true } } : undefined,
          query: { minScore: params.minScore ?? 0 },
          cache: params.cacheEnabled !== undefined ? { enabled: params.cacheEnabled } : undefined,
          extraPaths: params.extraPaths,
          multimodal: params.multimodal,
          sources: params.sources,
          rememberAcrossConversations:
            params.rememberAcrossConversations ?? params.sessionMemory ?? false,
        },
      },
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      models: params.providerAliases ? { providers: params.providerAliases } : undefined,
    } as OpenClawConfig);
    setRuntimeConfigSnapshot(cfg);
    return cfg;
  };

  const requireManager = (result: ManagerResult, missingMessage = "manager missing") => {
    if (!result.manager) {
      throw new Error(result.error ?? missingMessage);
    }
    return result.manager as unknown as MemoryIndexManager;
  };

  const trackManager = (manager: MemoryIndexManager): void => {
    managers.add(manager);
  };

  const getManager = async (
    cfg: ManagerConfig,
    purpose?: "default" | "status" | "cli",
    inspectSources?: boolean,
  ): Promise<MemoryIndexManager> => {
    const manager = requireManager(
      await deps.getMemorySearchManager({
        runInBackgroundContext: runInMemoryTestBackgroundContext,
        cfg,
        agentId: "main",
        purpose,
        inspectSources,
      }),
    );
    trackManager(manager);
    return manager;
  };

  const getFreshManager = async (
    cfg: ManagerConfig,
    purpose?: "default" | "status" | "cli",
    inspectSources?: boolean,
  ): Promise<MemoryIndexManager> => {
    setRuntimeConfigSnapshot(cfg);
    return getManager(cfg, purpose, inspectSources);
  };

  const getPreparedPersistentManager = async (cfg: ManagerConfig): Promise<MemoryIndexManager> => {
    const manager = await getManager(cfg);
    await resetManager(manager);
    return manager;
  };

  const getPersistentManager = async (cfg: ManagerConfig): Promise<MemoryIndexManager> => {
    setRuntimeConfigSnapshot(cfg);
    return getPreparedPersistentManager(cfg);
  };

  const seedSessionTranscript = async (params: SessionTranscript): Promise<void> => {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = params.sessionKey ?? `agent:main:memory:${params.sessionId}`;
    const updatedAt = Date.now();
    const target = { agentId: "main", sessionKey, storePath };
    await fs.mkdir(sessionsDir, { recursive: true });
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: params.sessionId, updatedAt },
    });
    for (const message of params.messages) {
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        sessionId: params.sessionId,
        message: {
          role: message.role,
          timestamp: message.timestamp,
          content: [{ type: "text", text: message.content }],
          ...(message.senderIsOwner ? { __openclaw: { senderIsOwner: true } } : {}),
        },
      });
    }
  };

  const getFtsSessionManager = async (): Promise<MemoryIndexManager | null> => {
    providerState.forceNoProvider = true;
    const cfg = createConfig({
      provider: "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    return manager.status().fts?.available ? manager : null;
  };

  beforeAll(async () => {
    workerState = await createOpenClawTestState({
      prefix: "openclaw-mem-worker-fixture-",
      layout: "state-only",
      applyEnv: false,
    });
    // A file-owned store keeps shared SQLite workers available across complete case cleanup.
    await createPluginStateKeyedStoreForTests<boolean>("memory-core", {
      namespace: "index-fixture-worker",
      maxEntries: 1,
      env: workerState.env,
    }).register("ready", true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(Array.from(managers).map((manager) => manager.close()));
    await deps.closeAllMemorySearchManagers();
    await state.cleanup();
    resetMemoryCoreDreamingStateForTests();
    clearRegistry();
    managers.clear();
  });

  afterAll(() => workerState?.cleanup());

  beforeEach(async () => {
    vi.useRealTimers();
    clearRegistry();
    resetProviderState();

    state = await createOpenClawTestState({
      prefix: "openclaw-mem-fixtures-",
      layout: "state-only",
    });
    createConfig({});
    const memory = path.join(state.workspaceDir, "memory");
    await fs.mkdir(memory, { recursive: true });
    await configureMemoryCoreDreamingStateForTests();
    await fs.writeFile(
      path.join(memory, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  return {
    paths: {
      get root() {
        return state.root;
      },
      get stateDir() {
        return state.stateDir;
      },
      get workspace() {
        return state.workspaceDir;
      },
      get memory() {
        return path.join(state.workspaceDir, "memory");
      },
    },
    provider,
    createConfig,
    requireManager,
    trackManager,
    resetManager,
    getPersistentManager,
    getPreparedPersistentManager,
    getFreshManager,
    getFtsSessionManager,
    seedSessionTranscript,
  };
}

/** Fixture writes use the native test owner; the manager retains only its reader. */
export function memoryIndexFixtureWriter(manager: MemoryIndexManager): DatabaseSync {
  const databasePath = manager.status().dbPath;
  if (!databasePath) {
    throw new Error("Memory index fixture has no database path");
  }
  return requireNativeSqliteDatabase(
    openOpenClawAgentDatabase({ agentId: "main", path: databasePath }).db,
  );
}

export function countMemoryIndexFtsMatches(databasePath: string, marker: string): number {
  const observer = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      observer
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
        )
        .get(`"${marker}"`) as { count: number }
    ).count;
  } finally {
    observer.close();
  }
}

export function holdMemoryTestOperation<T>(value: () => T) {
  const entered = createDeferred<void>();
  const gate = createDeferred<void>();
  return {
    entered: entered.promise,
    release: () => gate.resolve(),
    run: async () => {
      entered.resolve();
      await gate.promise;
      return value();
    },
  };
}

export function readPublishedSessionIndex(
  database: DatabaseSync,
  sessionPath: string,
  query: string,
) {
  return {
    source: database
      .prepare(
        "SELECT path, hash, mtime, size FROM memory_index_sources WHERE path = ? AND source = 'sessions'",
      )
      .get(sessionPath),
    chunks: database
      .prepare(
        "SELECT id, hash, text, embedding, updated_at FROM memory_index_chunks WHERE path = ? AND source = 'sessions' ORDER BY id",
      )
      .all(sessionPath),
    search: database
      .prepare(
        "SELECT text, id, path, model, start_line, end_line FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? AND path = ? ORDER BY id",
      )
      .all(query, sessionPath),
  };
}
