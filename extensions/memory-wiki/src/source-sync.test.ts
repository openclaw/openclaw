import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { deferred } from "./deferred.test-helpers.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";

const { syncBridgeMock, syncUnsafeLocalMock, refreshIndexesMock } = vi.hoisted(() => ({
  syncBridgeMock: vi.fn(),
  syncUnsafeLocalMock: vi.fn(),
  refreshIndexesMock: vi.fn(),
}));

// mock-isolation: test sync orchestration without source I/O or index execution.
vi.mock("./bridge.js", () => ({ syncMemoryWikiBridgeSources: syncBridgeMock }));
// mock-isolation: test sync orchestration without source I/O or index execution.
vi.mock("./unsafe-local.js", () => ({ syncMemoryWikiUnsafeLocalSources: syncUnsafeLocalMock }));
// mock-isolation: test sync orchestration without source I/O or index execution.
vi.mock("./compile.js", () => ({ refreshMemoryWikiIndexesAfterImport: refreshIndexesMock }));

const bridgeResult = {
  importedCount: 1,
  updatedCount: 2,
  skippedCount: 3,
  removedCount: 4,
  artifactCount: 10,
  workspaces: 2,
  pagePaths: ["sources/alpha.md"],
};

const refreshResult = {
  refreshed: true,
  reason: "import-changed" as const,
  compile: { updatedFiles: ["index.md", "sources/index.md"] },
};

const appConfig = { agents: { entries: { main: {} } } } as OpenClawConfig;
let vaultCounter = 0;

function createConfig(
  vaultMode: "bridge" | "unsafe-local" | "isolated" = "bridge",
  vaultPath = path.join(os.tmpdir(), `memory-wiki-source-sync-${vaultCounter++}`),
) {
  return resolveMemoryWikiConfig({ vaultMode, vault: { path: vaultPath } });
}

function runSync(
  config: ReturnType<typeof createConfig>,
  options: Omit<Parameters<typeof syncMemoryWikiImportedSources>[0], "config"> = {},
) {
  return syncMemoryWikiImportedSources({ config, appConfig, ...options });
}

async function pauseBridge(config = createConfig(), options = {}) {
  const gate = deferred<typeof bridgeResult>();
  syncBridgeMock.mockReturnValueOnce(gate.promise);
  const pending = runSync(config, options);
  await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(1));
  return { pending, resume: () => gate.resolve(bridgeResult) };
}

describe("syncMemoryWikiImportedSources", () => {
  beforeEach(() => {
    syncBridgeMock.mockReset().mockResolvedValue(bridgeResult);
    syncUnsafeLocalMock.mockReset().mockResolvedValue({ ...bridgeResult, workspaces: 0 });
    refreshIndexesMock.mockReset().mockResolvedValue(refreshResult);
  });

  it("does not share a deferred flight with a refreshing one", async () => {
    const config = createConfig();
    const { pending: deferredSync, resume } = await pauseBridge(config, {
      deferIndexRefresh: true,
    });
    const refreshing = runSync(config);
    resume();
    await expect(refreshing).resolves.toMatchObject({ indexesRefreshed: true });
    await expect(deferredSync).resolves.toMatchObject({ indexesRefreshed: false });
    expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces separately resolved equivalent configs for one vault", async () => {
    const firstConfig = createConfig();
    const secondConfig = createConfig("bridge", firstConfig.vault.path);
    const { pending: first, resume } = await pauseBridge(firstConfig);
    const second = runSync(secondConfig);
    await Promise.resolve();
    expect(syncBridgeMock).toHaveBeenCalledTimes(1);
    resume();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
    expect(secondResult).toBe(firstResult);
  });

  it("keeps sharing the active flight while indexes refresh", async () => {
    const config = createConfig();
    const refreshGate = deferred<typeof refreshResult>();
    refreshIndexesMock.mockReturnValueOnce(refreshGate.promise);
    const first = runSync(config);
    await vi.waitFor(() => expect(refreshIndexesMock).toHaveBeenCalledTimes(1));
    const followers = Array.from({ length: 32 }, () => runSync(config));
    await Promise.resolve();
    expect(syncBridgeMock).toHaveBeenCalledTimes(1);
    expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
    refreshGate.resolve(refreshResult);
    const [firstResult, ...followerResults] = await Promise.all([first, ...followers]);
    expect(followerResults.every((result) => result === firstResult)).toBe(true);
  });

  it("clears completed flights so later polls observe new source state", async () => {
    const config = createConfig();
    await runSync(config);
    syncBridgeMock.mockResolvedValueOnce({ ...bridgeResult, updatedCount: 3 });
    await expect(runSync(config)).resolves.toMatchObject({ updatedCount: 3 });
    expect(syncBridgeMock).toHaveBeenCalledTimes(2);
    expect(refreshIndexesMock).toHaveBeenCalledTimes(2);
  });

  it("waits for an existing vault mutation before starting source sync", async () => {
    const config = createConfig();
    const blockerEntered = deferred();
    const blockerGate = deferred();
    const blocker = withMemoryWikiVaultMutation(config.vault.path, async () => {
      blockerEntered.resolve(undefined);
      await blockerGate.promise;
    });
    await blockerEntered.promise;
    const sync = runSync(config);
    await Promise.resolve();
    expect(syncBridgeMock).not.toHaveBeenCalled();
    blockerGate.resolve(undefined);
    await blocker;
    await sync;
    expect(syncBridgeMock).toHaveBeenCalledTimes(1);
  });

  it.each(["config snapshots", "bridge and unsafe-local modes"])(
    "serializes %s for one vault",
    async (variant) => {
      const config = createConfig();
      const modes = variant === "bridge and unsafe-local modes";
      const options = (channel: "stable" | "beta") => ({
        appConfig: modes ? appConfig : { ...appConfig, update: { channel } },
      });
      const { pending: first, resume } = await pauseBridge(config, options("stable"));
      const secondResult = { ...bridgeResult, pagePaths: ["sources/beta.md"] };
      const importer = modes ? syncUnsafeLocalMock : syncBridgeMock;
      importer.mockResolvedValueOnce(secondResult);
      const second = runSync(
        modes ? createConfig("unsafe-local", config.vault.path) : config,
        options("beta"),
      );
      await Promise.resolve();
      expect(syncBridgeMock).toHaveBeenCalledTimes(1);
      expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
      resume();
      await first;
      await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(modes ? 1 : 2));
      await expect(second).resolves.toMatchObject({ pagePaths: ["sources/beta.md"] });
      expect(refreshIndexesMock).toHaveBeenCalledTimes(2);
    },
  );

  it("allows different agent vaults to sync in parallel", async () => {
    const firstConfig = createConfig();
    const secondConfig = createConfig();
    const secondResult = { ...bridgeResult, pagePaths: ["sources/other.md"] };
    const { pending: first, resume } = await pauseBridge(firstConfig);
    syncBridgeMock.mockResolvedValueOnce(secondResult);
    const second = runSync(secondConfig);
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(2));
    await expect(second).resolves.toMatchObject({ pagePaths: ["sources/other.md"] });
    resume();
    await first;
  });

  it("clears failed flights so a later sync can retry", async () => {
    const config = createConfig();
    syncBridgeMock.mockRejectedValueOnce(new Error("bridge unavailable"));
    await expect(runSync(config)).rejects.toThrow("bridge unavailable");
    await expect(runSync(config)).resolves.toMatchObject({ pagePaths: bridgeResult.pagePaths });
    expect(syncBridgeMock).toHaveBeenCalledTimes(2);
  });

  it("routes unsafe-local mode through unsafe-local sync", async () => {
    const unsafeLocalResult = {
      ...bridgeResult,
      importedCount: 2,
      workspaces: 0,
      pagePaths: ["sources/private.md"],
    };
    syncUnsafeLocalMock.mockResolvedValueOnce(unsafeLocalResult);
    refreshIndexesMock.mockResolvedValueOnce({ refreshed: false, reason: "auto-compile-disabled" });
    const config = createConfig("unsafe-local");
    const result = await syncMemoryWikiImportedSources({ config });
    expect(syncUnsafeLocalMock).toHaveBeenCalledWith(config);
    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({ config, syncResult: unsafeLocalResult });
    expect(result).toEqual({
      ...unsafeLocalResult,
      indexesRefreshed: false,
      indexRefreshReason: "auto-compile-disabled",
      indexUpdatedFiles: [],
    });
  });
});
