// Memory Wiki tests cover source sync plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncMemoryWikiImportedSources } from "./source-sync.js";

const { syncBridgeMock, syncUnsafeLocalMock, refreshIndexesMock } = vi.hoisted(() => ({
  syncBridgeMock: vi.fn(),
  syncUnsafeLocalMock: vi.fn(),
  refreshIndexesMock: vi.fn(),
}));

vi.mock("./bridge.js", () => ({
  syncMemoryWikiBridgeSources: syncBridgeMock,
}));

vi.mock("./unsafe-local.js", () => ({
  syncMemoryWikiUnsafeLocalSources: syncUnsafeLocalMock,
}));

vi.mock("./compile.js", () => ({
  refreshMemoryWikiIndexesAfterImport: refreshIndexesMock,
}));

const bridgeResult = {
  importedCount: 1,
  updatedCount: 2,
  skippedCount: 3,
  removedCount: 4,
  artifactCount: 10,
  workspaces: 2,
  pagePaths: ["sources/alpha.md"],
};

function createBridgeConfig(): Parameters<typeof syncMemoryWikiImportedSources>[0]["config"] {
  return {
    vaultMode: "bridge",
    vault: {
      path: "/tmp/memory-wiki-source-sync-test",
      renderMode: "native",
    },
    obsidian: {
      enabled: false,
      useOfficialCli: false,
      openAfterWrites: false,
    },
    bridge: {
      enabled: true,
      readMemoryArtifacts: true,
      indexDreamReports: true,
      indexDailyNotes: true,
      indexMemoryRoot: true,
      followMemoryEvents: false,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: false,
      paths: [],
    },
    ingest: {
      autoCompile: true,
      maxConcurrentJobs: 2,
      allowUrlIngest: false,
    },
    search: {
      backend: "local",
      corpus: "wiki",
    },
    context: {
      includeCompiledDigestPrompt: false,
    },
    render: {
      preserveHumanBlocks: true,
      createBacklinks: true,
      createDashboards: true,
    },
  } as Parameters<typeof syncMemoryWikiImportedSources>[0]["config"];
}

describe("syncMemoryWikiImportedSources", () => {
  beforeEach(() => {
    syncBridgeMock.mockReset();
    syncUnsafeLocalMock.mockReset();
    refreshIndexesMock.mockReset();
    syncBridgeMock.mockResolvedValue(bridgeResult);
    syncUnsafeLocalMock.mockResolvedValue({
      ...bridgeResult,
      workspaces: 0,
    });
    refreshIndexesMock.mockResolvedValue({
      refreshed: true,
      reason: "import-changed",
      compile: { updatedFiles: ["index.md", "sources/index.md"] },
    });
  });

  it("routes bridge mode through bridge sync and merges refresh results", async () => {
    const config = createBridgeConfig();
    const appConfig = { agents: { list: [{ id: "main", default: true }] } } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["appConfig"];

    const result = await syncMemoryWikiImportedSources({ config, appConfig });

    expect(syncBridgeMock).toHaveBeenCalledWith({ config, appConfig });
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: bridgeResult,
    });
    expect(result).toEqual({
      ...bridgeResult,
      indexesRefreshed: true,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
    });
  });

  it("coalesces concurrent bridge sync and index refresh for the same vault", async () => {
    const config = createBridgeConfig();
    const appConfig = { agents: { list: [{ id: "main", default: true }] } } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["appConfig"];
    let resolveBridge!: (value: typeof bridgeResult) => void;
    syncBridgeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBridge = resolve;
      }),
    );

    const first = syncMemoryWikiImportedSources({ config, appConfig });
    const second = syncMemoryWikiImportedSources({ config, appConfig });

    expect(syncBridgeMock).toHaveBeenCalledTimes(1);
    expect(refreshIndexesMock).not.toHaveBeenCalled();

    resolveBridge(bridgeResult);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual({
      ...bridgeResult,
      indexesRefreshed: true,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
    });
    expect(secondResult).toEqual(firstResult);
  });

  it("keeps concurrent bridge syncs separate when default workspaces differ", async () => {
    const config = createBridgeConfig();
    const firstAppConfig = {
      agents: {
        defaults: { workspace: "/tmp/memory-wiki-source-sync-workspace-a" },
        list: [{ id: "main", default: true }],
      },
    } as Parameters<typeof syncMemoryWikiImportedSources>[0]["appConfig"];
    const secondAppConfig = {
      agents: {
        defaults: { workspace: "/tmp/memory-wiki-source-sync-workspace-b" },
        list: [{ id: "main", default: true }],
      },
    } as Parameters<typeof syncMemoryWikiImportedSources>[0]["appConfig"];
    const firstBridgeResult = { ...bridgeResult, pagePaths: ["sources/a.md"] };
    const secondBridgeResult = { ...bridgeResult, pagePaths: ["sources/b.md"] };
    let resolveFirstBridge!: (value: typeof firstBridgeResult) => void;
    let resolveSecondBridge!: (value: typeof secondBridgeResult) => void;
    syncBridgeMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstBridge = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondBridge = resolve;
        }),
      );

    const first = syncMemoryWikiImportedSources({ config, appConfig: firstAppConfig });
    const second = syncMemoryWikiImportedSources({ config, appConfig: secondAppConfig });

    expect(syncBridgeMock).toHaveBeenCalledTimes(2);
    expect(syncBridgeMock).toHaveBeenNthCalledWith(1, { config, appConfig: firstAppConfig });
    expect(syncBridgeMock).toHaveBeenNthCalledWith(2, { config, appConfig: secondAppConfig });

    resolveFirstBridge(firstBridgeResult);
    resolveSecondBridge(secondBridgeResult);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(refreshIndexesMock).toHaveBeenCalledTimes(2);
    expect(firstResult.pagePaths).toEqual(["sources/a.md"]);
    expect(secondResult.pagePaths).toEqual(["sources/b.md"]);
  });

  it("routes unsafe-local mode through unsafe-local sync", async () => {
    const unsafeLocalResult = {
      ...bridgeResult,
      importedCount: 2,
      workspaces: 0,
      pagePaths: ["sources/private.md"],
    };
    syncUnsafeLocalMock.mockResolvedValueOnce(unsafeLocalResult);
    refreshIndexesMock.mockResolvedValueOnce({
      refreshed: false,
      reason: "auto-compile-disabled",
    });
    const config = { vaultMode: "unsafe-local" } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["config"];

    const result = await syncMemoryWikiImportedSources({ config });

    expect(syncUnsafeLocalMock).toHaveBeenCalledWith(config);
    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: unsafeLocalResult,
    });
    expect(result).toEqual({
      ...unsafeLocalResult,
      indexesRefreshed: false,
      indexRefreshReason: "auto-compile-disabled",
      indexUpdatedFiles: [],
    });
  });

  it("returns a no-op sync result outside imported-source modes", async () => {
    const config = { vaultMode: "isolated" } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["config"];

    const result = await syncMemoryWikiImportedSources({ config });

    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: {
        importedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        removedCount: 0,
        artifactCount: 0,
        workspaces: 0,
        pagePaths: [],
      },
    });
    expect(result).toEqual({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
      indexesRefreshed: true,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
    });
  });
});
