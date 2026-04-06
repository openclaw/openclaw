import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, beforeAll, beforeEach, expect, vi, type Mock } from "vitest";
import type { MemoryIndexManager } from "./index.js";

type EmbeddingTestMocksModule = typeof import("./embedding.test-mocks.js");
type MemoryIndexModule = typeof import("./index.js");
type MemoryEmbeddingProvidersModule =
  typeof import("../../../../src/plugins/memory-embedding-providers.js");
type MemorySearchManagerHandle = Awaited<
  ReturnType<MemoryIndexModule["getMemorySearchManager"]>
>["manager"];

export function installEmbeddingManagerFixture(opts: {
  fixturePrefix: string;
  largeTokens: number;
  smallTokens: number;
  createCfg: (params: {
    workspaceDir: string;
    indexPath: string;
    tokens: number;
  }) => OpenClawConfig;
  resetIndexEachTest?: boolean;
}) {
  const resetIndexEachTest = opts.resetIndexEachTest ?? true;

  let fixtureRoot: string | undefined;
  let workspaceDir: string | undefined;
  let memoryDir: string | undefined;
  let managerLarge: MemoryIndexManager | undefined;
  let managerSmall: MemoryIndexManager | undefined;
  let embedBatch: Mock<(texts: string[]) => Promise<number[][]>> | undefined;
  let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
  let resetEmbeddingMocks: EmbeddingTestMocksModule["resetEmbeddingMocks"];
  let clearRegistry: MemoryEmbeddingProvidersModule["clearMemoryEmbeddingProviders"];
  let registerAdapter: MemoryEmbeddingProvidersModule["registerMemoryEmbeddingProvider"];
  let restoreRegistry: MemoryEmbeddingProvidersModule["restoreRegisteredMemoryEmbeddingProviders"];
  let listRegistry: MemoryEmbeddingProvidersModule["listRegisteredMemoryEmbeddingProviders"];
  let originalRegistry:
    | ReturnType<MemoryEmbeddingProvidersModule["listRegisteredMemoryEmbeddingProviders"]>
    | undefined;

  const resetManager = (manager: MemoryIndexManager) => {
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    (manager as unknown as { dirty: boolean }).dirty = true;
  };

  const requireValue = <T>(value: T | undefined, name: string): T => {
    if (!value) {
      throw new Error(`${name} missing`);
    }
    return value;
  };

  const requireIndexManager = (
    manager: MemorySearchManagerHandle,
    name: string,
  ): MemoryIndexManager => {
    if (!manager) {
      throw new Error(`${name} missing`);
    }
    if (!("resetIndex" in manager) || typeof manager.resetIndex !== "function") {
      throw new Error(`${name} is not a MemoryIndexManager`);
    }
    return manager as unknown as MemoryIndexManager;
  };

  const createManager = async (params: {
    indexPath: string;
    tokens: number;
    name: string;
  }): Promise<MemoryIndexManager> => {
    const managerResult = await getMemorySearchManager({
      cfg: opts.createCfg({
        workspaceDir: requireValue(workspaceDir, "workspaceDir"),
        indexPath: params.indexPath,
        tokens: params.tokens,
      }),
      agentId: "main",
    });
    expect(managerResult.manager).not.toBeNull();
    return requireIndexManager(managerResult.manager, params.name);
  };

  beforeAll(async () => {
    vi.resetModules();
    await import("./embedding.test-mocks.js");
    const embeddingMocks = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks.resetEmbeddingMocks;
    ({ getMemorySearchManager } = await import("./index.js"));
    ({
      clearMemoryEmbeddingProviders: clearRegistry,
      registerMemoryEmbeddingProvider: registerAdapter,
      restoreRegisteredMemoryEmbeddingProviders: restoreRegistry,
      listRegisteredMemoryEmbeddingProviders: listRegistry,
    } = await import("../../../../src/plugins/memory-embedding-providers.js"));
    const savedRegistry = listRegistry();
    clearRegistry();
    registerAdapter({
      id: "openai",
      defaultModel: "mock-embed",
      transport: "remote",
      create: async () => ({ provider: null }),
    });
    originalRegistry = savedRegistry;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), opts.fixturePrefix));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterAll(async () => {
    if (managerLarge) {
      await managerLarge.close();
      managerLarge = undefined;
    }
    if (managerSmall) {
      await managerSmall.close();
      managerSmall = undefined;
    }
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
    if (originalRegistry) {
      restoreRegistry(originalRegistry);
      originalRegistry = undefined;
    } else {
      clearRegistry();
    }
  });

  beforeEach(async () => {
    resetEmbeddingMocks();

    const dir = requireValue(memoryDir, "memoryDir");
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    if (resetIndexEachTest) {
      if (managerLarge) {
        resetManager(managerLarge);
      }
      if (managerSmall) {
        resetManager(managerSmall);
      }
    }
  });

  return {
    get embedBatch() {
      return requireValue(embedBatch, "embedBatch");
    },
    getFixtureRoot: () => requireValue(fixtureRoot, "fixtureRoot"),
    getWorkspaceDir: () => requireValue(workspaceDir, "workspaceDir"),
    getMemoryDir: () => requireValue(memoryDir, "memoryDir"),
    getManagerLarge: async () => {
      managerLarge ??= await createManager({
        indexPath: path.join(requireValue(fixtureRoot, "fixtureRoot"), "index.large.sqlite"),
        tokens: opts.largeTokens,
        name: "managerLarge",
      });
      return managerLarge;
    },
    getManagerSmall: async () => {
      managerSmall ??= await createManager({
        indexPath: path.join(requireValue(fixtureRoot, "fixtureRoot"), "index.small.sqlite"),
        tokens: opts.smallTokens,
        name: "managerSmall",
      });
      return managerSmall;
    },
    resetManager,
  };
}
