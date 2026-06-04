import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncMemoryWikiImportedSources } from "./source-sync.js";

const { syncBridgeMock, syncUnsafeLocalMock, syncLocalImportMock, refreshIndexesMock } = vi.hoisted(
  () => ({
    syncBridgeMock: vi.fn(),
    syncUnsafeLocalMock: vi.fn(),
    syncLocalImportMock: vi.fn(),
    refreshIndexesMock: vi.fn(),
  }),
);

vi.mock("./bridge.js", () => ({
  syncMemoryWikiBridgeSources: syncBridgeMock,
}));

vi.mock("./unsafe-local.js", () => ({
  syncMemoryWikiUnsafeLocalSources: syncUnsafeLocalMock,
}));

vi.mock("./local-import.js", () => ({
  syncMemoryWikiLocalImportSources: syncLocalImportMock,
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

describe("syncMemoryWikiImportedSources", () => {
  beforeEach(() => {
    syncBridgeMock.mockReset();
    syncUnsafeLocalMock.mockReset();
    syncLocalImportMock.mockReset();
    refreshIndexesMock.mockReset();
    syncBridgeMock.mockResolvedValue(bridgeResult);
    syncUnsafeLocalMock.mockResolvedValue({
      ...bridgeResult,
      workspaces: 0,
    });
    syncLocalImportMock.mockResolvedValue({
      ...bridgeResult,
      artifactCount: 0,
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      workspaces: 0,
      pagePaths: [],
    });
    refreshIndexesMock.mockResolvedValue({
      refreshed: true,
      reason: "import-changed",
      compile: { updatedFiles: ["index.md", "sources/index.md"] },
    });
  });

  it("routes bridge mode through bridge sync and merges refresh results", async () => {
    const config = { vaultMode: "bridge" } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["config"];
    const appConfig = { agents: { list: [{ id: "main", default: true }] } } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["appConfig"];

    const result = await syncMemoryWikiImportedSources({ config, appConfig });

    expect(syncBridgeMock).toHaveBeenCalledWith({ config, appConfig });
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(syncLocalImportMock).not.toHaveBeenCalled();
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
    expect(syncLocalImportMock).not.toHaveBeenCalled();
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
    expect(syncLocalImportMock).not.toHaveBeenCalled();
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

  it("syncs enabled local imports outside imported-source vault modes", async () => {
    const localImportResult = {
      ...bridgeResult,
      importedCount: 1,
      artifactCount: 1,
      workspaces: 0,
      pagePaths: ["sources/local.md"],
    };
    syncLocalImportMock.mockResolvedValueOnce(localImportResult);
    const config = {
      vaultMode: "isolated",
      localImports: { enabled: true },
    } as Parameters<typeof syncMemoryWikiImportedSources>[0]["config"];

    const result = await syncMemoryWikiImportedSources({ config });

    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(syncLocalImportMock).toHaveBeenCalledWith(config);
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: localImportResult,
    });
    expect(result).toEqual({
      ...localImportResult,
      indexesRefreshed: true,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
    });
  });

  it("merges bridge and enabled local import sync results before index refresh", async () => {
    const localImportResult = {
      ...bridgeResult,
      importedCount: 5,
      updatedCount: 0,
      skippedCount: 1,
      removedCount: 0,
      artifactCount: 6,
      workspaces: 0,
      pagePaths: ["sources/local.md"],
    };
    syncLocalImportMock.mockResolvedValueOnce(localImportResult);
    const config = {
      vaultMode: "bridge",
      localImports: { enabled: true },
    } as Parameters<typeof syncMemoryWikiImportedSources>[0]["config"];
    const appConfig = { agents: { list: [{ id: "main", default: true }] } } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["appConfig"];

    const result = await syncMemoryWikiImportedSources({ config, appConfig });

    const expectedMerged = {
      importedCount: 6,
      updatedCount: 2,
      skippedCount: 4,
      removedCount: 4,
      artifactCount: 16,
      workspaces: 2,
      pagePaths: ["sources/alpha.md", "sources/local.md"],
    };
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: expectedMerged,
    });
    expect(result).toEqual({
      ...expectedMerged,
      indexesRefreshed: true,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
    });
  });
});
