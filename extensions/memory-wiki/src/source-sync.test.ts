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

  it.each(["import", "refresh"] as const)(
    "coalesces equivalent configs throughout %s",
    async (phase) => {
      const config = createConfig();
      const gate = deferred<typeof bridgeResult | typeof refreshResult>();
      const paused = phase === "import" ? syncBridgeMock : refreshIndexesMock;
      paused.mockReturnValueOnce(gate.promise);
      const first = runSync(config);
      await vi.waitFor(() => expect(paused).toHaveBeenCalledTimes(1));
      const followers = Array.from({ length: 32 }, () =>
        runSync(createConfig("bridge", config.vault.path)),
      );
      await Promise.resolve();
      expect(syncBridgeMock).toHaveBeenCalledTimes(1);
      expect(refreshIndexesMock).toHaveBeenCalledTimes(phase === "import" ? 0 : 1);
      gate.resolve(phase === "import" ? bridgeResult : refreshResult);
      const [result, ...others] = await Promise.all([first, ...followers]);
      expect(others.every((other) => other === result)).toBe(true);
      expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])("clears settled flights (failed: %s)", async (failed) => {
    const config = createConfig();
    if (failed) {
      syncBridgeMock.mockRejectedValueOnce(new Error("bridge unavailable"));
      await expect(runSync(config)).rejects.toThrow("bridge unavailable");
    } else {
      await runSync(config);
    }
    syncBridgeMock.mockResolvedValueOnce({ ...bridgeResult, updatedCount: 3 });
    await expect(runSync(config)).resolves.toMatchObject({
      updatedCount: 3,
      pagePaths: bridgeResult.pagePaths,
    });
    expect(syncBridgeMock).toHaveBeenCalledTimes(2);
    expect(refreshIndexesMock).toHaveBeenCalledTimes(failed ? 1 : 2);
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
      if (modes) {
        refreshIndexesMock
          .mockResolvedValueOnce(refreshResult)
          .mockResolvedValueOnce({ refreshed: false, reason: "auto-compile-disabled" });
      }
      const second = runSync(
        modes ? createConfig("unsafe-local", config.vault.path) : config,
        options("beta"),
      );
      await Promise.resolve();
      expect(syncBridgeMock).toHaveBeenCalledTimes(1);
      expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
      resume();
      await first;
      await expect(second).resolves.toEqual({
        ...secondResult,
        indexesRefreshed: !modes,
        indexRefreshReason: modes ? "auto-compile-disabled" : "import-changed",
        indexUpdatedFiles: modes ? [] : refreshResult.compile.updatedFiles,
      });
      expect(importer).toHaveBeenCalledTimes(modes ? 1 : 2);
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
});
