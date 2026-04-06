import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./embeddings.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderRuntime,
  EmbeddingProviderResult,
} from "./embeddings.js";
import type { MemoryIndexManager } from "./index.js";
type MemoryIndexModule = typeof import("./index.js");

const { createEmbeddingProviderMock } = vi.hoisted(() => ({
  createEmbeddingProviderMock: vi.fn(),
}));

vi.mock("./embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
  return {
    ...actual,
    createEmbeddingProvider: createEmbeddingProviderMock,
  };
});

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

async function ensureProviderInitialized(manager: MemoryIndexManager): Promise<void> {
  await (
    manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
    }
  ).ensureProviderInitialized();
}

function createProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: `${id}-model`,
    embedQuery: async () => [0.1, 0.2, 0.3],
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  };
}

function buildConfig(params: {
  workspaceDir: string;
  indexPath: string;
  provider: "openai" | "mistral";
  fallback?: "none" | "mistral" | "ollama";
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          provider: params.provider,
          model: params.provider === "mistral" ? "mistral/mistral-embed" : "text-embedding-3-small",
          fallback: params.fallback ?? "none",
          store: { path: params.indexPath, vector: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("memory manager mistral provider wiring", () => {
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    vi.resetModules();
    ({ getMemorySearchManager, closeAllMemorySearchManagers } = await import("./index.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    createEmbeddingProviderMock.mockReset();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-mistral-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "test");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      indexPath = "";
    }
  });

  afterAll(() => {
    vi.resetModules();
  });

  it("stores mistral client when mistral provider is selected", async () => {
    const mistralRuntime: EmbeddingProviderRuntime = {
      id: "mistral",
      cacheKeyData: { provider: "mistral", model: "mistral-embed" },
    };
    const providerResult: EmbeddingProviderResult = {
      requestedProvider: "mistral",
      provider: createProvider("mistral"),
      runtime: mistralRuntime,
    };
    createEmbeddingProviderMock.mockResolvedValueOnce(providerResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "mistral" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    await ensureProviderInitialized(manager);

    const internal = manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
      providerRuntime?: EmbeddingProviderRuntime;
    };
    await internal.ensureProviderInitialized();
    expect(internal.providerRuntime).toBe(mistralRuntime);
  });

  it("stores mistral client after fallback activation", async () => {
    const openAiRuntime: EmbeddingProviderRuntime = {
      id: "openai",
      cacheKeyData: { provider: "openai", model: "text-embedding-3-small" },
    };
    const mistralRuntime: EmbeddingProviderRuntime = {
      id: "mistral",
      cacheKeyData: { provider: "mistral", model: "mistral-embed" },
    };
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "openai",
      provider: createProvider("openai"),
      runtime: openAiRuntime,
    } as EmbeddingProviderResult);
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "mistral",
      provider: createProvider("mistral"),
      runtime: mistralRuntime,
    } as EmbeddingProviderResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "openai", fallback: "mistral" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    await ensureProviderInitialized(manager);
    const internal = manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      providerRuntime?: EmbeddingProviderRuntime;
    };

    await internal.ensureProviderInitialized();
    expect(internal.providerRuntime?.id).toBe("openai");
    const activated = await internal.activateFallbackProvider("forced test");
    expect(activated).toBe(true);
    expect(internal.providerRuntime).toBe(mistralRuntime);
  });

  it("uses default ollama model when activating ollama fallback", async () => {
    const openAiRuntime: EmbeddingProviderRuntime = {
      id: "openai",
      cacheKeyData: { provider: "openai", model: "text-embedding-3-small" },
    };
    const ollamaRuntime: EmbeddingProviderRuntime = {
      id: "ollama",
      cacheKeyData: { provider: "ollama", model: DEFAULT_OLLAMA_EMBEDDING_MODEL },
    };
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "openai",
      provider: createProvider("openai"),
      runtime: openAiRuntime,
    } as EmbeddingProviderResult);
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "ollama",
      provider: createProvider("ollama"),
      runtime: ollamaRuntime,
    } as EmbeddingProviderResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "openai", fallback: "ollama" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    await ensureProviderInitialized(manager);
    const internal = manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      providerRuntime?: EmbeddingProviderRuntime;
    };

    await internal.ensureProviderInitialized();
    expect(internal.providerRuntime?.id).toBe("openai");
    const activated = await internal.activateFallbackProvider("forced ollama fallback");
    expect(activated).toBe(true);
    expect(internal.providerRuntime).toBe(ollamaRuntime);

    const fallbackCall = createEmbeddingProviderMock.mock.calls[1]?.[0] as
      | { provider?: string; model?: string }
      | undefined;
    expect(fallbackCall?.provider).toBe("ollama");
    expect(fallbackCall?.model).toBe(DEFAULT_OLLAMA_EMBEDDING_MODEL);
  });
});
