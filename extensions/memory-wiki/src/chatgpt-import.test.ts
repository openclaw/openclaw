// Memory Wiki tests cover crash-safe ChatGPT rollback behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rollbackChatGptImportRun } from "./chatgpt-import.js";
import { configureMemoryWikiCompiledCacheStore } from "./compiled-cache.js";
import { deferred } from "./deferred.test-helpers.js";
import type { RootMoveHooks } from "./guarded-root.test-support.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
  getMemoryWikiImportRunStateStore,
  type ChatGptImportRunRecord,
} from "./import-runs-state.js";
import { WIKI_RELATED_END_MARKER, WIKI_RELATED_START_MARKER } from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const compileControl = vi.hoisted(() => ({ calls: 0 }));

const rootControl = vi.hoisted(() => ({
  afterMove: undefined as RootMoveHooks["afterMove"],
  moves: vi.fn<(from: string, to: string) => void>(),
  lists: [] as Array<{ rootDir: string; calls: [string, ...unknown[]][] }>,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  const { observeRootMoves } = await import("./guarded-root.test-support.js");
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const vault = observeRootMoves(await actual.root(...args), {
        beforeMove: rootControl.moves,
        afterMove: (from, to) => rootControl.afterMove?.(from, to),
      });
      const list = vi.spyOn(vault, "list");
      rootControl.lists.push({ rootDir: vault.rootDir, calls: list.mock.calls });
      return vault;
    },
  };
});

vi.mock("./compile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compile.js")>();
  return {
    ...actual,
    compileMemoryWikiVault: async (
      ...args: Parameters<typeof actual.compileMemoryWikiVault>
    ): ReturnType<typeof actual.compileMemoryWikiVault> => {
      compileControl.calls += 1;
      return await actual.compileMemoryWikiVault(...args);
    },
  };
});

const { configureCompiledCacheStore, createTempDir, createVault } = createMemoryWikiTestHarness();

type ImportStoreHooks = {
  beforeWrite?: (record: ChatGptImportRunRecord) => Promise<void>;
  afterWrite?: (record: ChatGptImportRunRecord) => Promise<void>;
};

function configureDurableImportRunStore(stateDir: string, hooks?: ImportStoreHooks): void {
  const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const store = createMemoryWikiImportRunStateStore(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
  );
  configureMemoryWikiImportRunStateStore(
    hooks
      ? {
          ...store,
          async write(vaultRoot, record) {
            await hooks.beforeWrite?.(record);
            await store.write(vaultRoot, record);
            await hooks.afterWrite?.(record);
          },
        }
      : store,
  );
}

async function createRollbackVault(runId: string, initialize = true) {
  const stateDir = await createTempDir("memory-wiki-chatgpt-state-");
  const vault = await createVault({ initialize });
  configureDurableImportRunStore(stateDir);
  return {
    stateDir,
    ...vault,
    runId,
    rollback: () => rollbackChatGptImportRun({ config: vault.config, runId }),
    readRun: () => getMemoryWikiImportRunStateStore().read(vault.rootDir, runId),
    seedCreated: (relativePath: string, contentHash: string) =>
      seedRollback(vault.rootDir, runId, { createdPaths: [{ path: relativePath, contentHash }] }),
  };
}

function reopenStore(stateDir: string) {
  resetPluginStateStoreForTests();
  configureDurableImportRunStore(stateDir);
}

function hash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function seedRollback(
  vaultRoot: string,
  runId: string,
  {
    createdPaths = [],
    updatedPaths = [],
  }: Partial<Pick<ChatGptImportRunRecord, "createdPaths" | "updatedPaths">>,
): Promise<void> {
  await getMemoryWikiImportRunStateStore().write(vaultRoot, {
    version: 1,
    runId,
    importType: "chatgpt",
    exportPath: "/tmp/chatgpt",
    sourcePath: "/tmp/chatgpt/conversations.json",
    appliedAt: "2026-04-10T10:00:00.000Z",
    conversationCount: createdPaths.length + updatedPaths.length,
    createdCount: createdPaths.length,
    updatedCount: updatedPaths.length,
    skippedCount: 0,
    createdPaths,
    updatedPaths,
  });
}

function renderCompiledRelatedPage(base: string, suffix = ""): string {
  return `${base.trimEnd()}\n\n## Related\n${WIKI_RELATED_START_MARKER}\n- No related pages yet.\n${WIKI_RELATED_END_MARKER}\n${suffix}`;
}

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  compileControl.calls = 0;
  rootControl.afterMove = undefined;
  rootControl.moves.mockClear();
  rootControl.lists.length = 0;
  configureMemoryWikiImportRunStateStore(undefined);
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
});

describe("ChatGPT import rollback recovery", () => {
  it("persists the moving phase before vault initialization", async () => {
    const { rootDir, rollback, readRun, seedCreated } = await createRollbackVault(
      "chatgpt-started",
      false,
    );
    await seedCreated("sources/missing.md", "missing");

    const realMkdir = fs.mkdir;
    let checkedBeforeFirstVaultWrite = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const targetPath = path.resolve(String(args[0]));
      if (
        !checkedBeforeFirstVaultWrite &&
        (targetPath === path.resolve(rootDir) ||
          targetPath.startsWith(`${path.resolve(rootDir)}${path.sep}`))
      ) {
        checkedBeforeFirstVaultWrite = true;
        await expect(readRun()).resolves.toMatchObject({
          rollbackStartedAt: expect.any(String),
        });
      }
      return await Reflect.apply(realMkdir, fs, args);
    });

    await expect(rollback()).resolves.toMatchObject({
      alreadyRolledBack: false,
    });
    expect(checkedBeforeFirstVaultWrite).toBe(true);
  });

  it("reconciles a crash after rename across a real SQLite reopen", async () => {
    const { stateDir, rootDir, rollback, readRun, seedCreated } =
      await createRollbackVault("chatgpt-crash-retry");
    const relativePath = "sources/retry.md";
    const targetPath = path.join(rootDir, relativePath);
    const imported = "# Imported\n";
    const edited = "# Edited after import\n";
    await fs.writeFile(targetPath, edited, "utf8");
    await seedCreated(relativePath, hash(imported));

    rootControl.afterMove = async (from, to) => {
      expect(from).toBe(targetPath);
      expect(path.basename(to)).toBe("content");
      rootControl.afterMove = undefined;
      await expect(readRun()).resolves.toMatchObject({
        rollbackStartedAt: expect.any(String),
      });
      await fs.writeFile(from, "# Recreated before fence\n", "utf8");
      throw new Error("simulated process crash after rename");
    };
    await expect(rollback()).rejects.toThrow("simulated process crash");
    rootControl.afterMove = undefined;
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("# Recreated before fence\n");
    await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).resolves.toBeDefined();

    reopenStore(stateDir);
    const retried = await rollback();
    expect(retried.alreadyRolledBack).toBe(false);
    expect(retried.preservedPaths).toHaveLength(2);
    const preserved = retried.preservedPaths[0];
    expect(preserved?.path).toBe(relativePath);
    const preservedContents = await Promise.all(
      retried.preservedPaths.map((entry) =>
        fs.readFile(path.join(rootDir, entry.recoveryPath), "utf8"),
      ),
    );
    expect(preservedContents).toEqual(
      expect.arrayContaining([edited, "# Recreated before fence\n"]),
    );

    await fs.writeFile(path.join(rootDir, preserved?.recoveryPath ?? ""), imported, "utf8");
    reopenStore(stateDir);
    rootControl.moves.mockClear();
    const mkdtempRetrySpy = vi.spyOn(fs, "mkdtemp");
    const rmRetrySpy = vi.spyOn(fs, "rm");
    const rmdirRetrySpy = vi.spyOn(fs, "rmdir");
    const compileCalls = compileControl.calls;
    const repeated = await rollback();
    expect(repeated.alreadyRolledBack).toBe(true);
    expect(repeated.preservedPaths).toStrictEqual(retried.preservedPaths);
    expect(rootControl.moves).not.toHaveBeenCalled();
    expect(mkdtempRetrySpy).not.toHaveBeenCalled();
    expect(rmRetrySpy).not.toHaveBeenCalled();
    expect(rmdirRetrySpy).not.toHaveBeenCalled();
    expect(compileControl.calls).toBe(compileCalls);
    await expect(
      fs.readFile(path.join(rootDir, preserved?.recoveryPath ?? ""), "utf8"),
    ).resolves.toBe(imported);
    await expect(readRun()).resolves.toMatchObject({
      rollbackStartedAt: expect.any(String),
      rollbackTargetsFinalizedAt: expect.any(String),
      rolledBackAt: expect.any(String),
      createdPaths: [
        {
          path: relativePath,
          recoveryPaths: retried.preservedPaths.map((entry) => entry.recoveryPath),
        },
      ],
    });
  });

  it("persists 32 recovery slots before retrying and preserving the 33rd target", async () => {
    const { stateDir, rootDir, rollback, readRun, seedCreated } =
      await createRollbackVault("chatgpt-capacity-retry");
    const relativePath = "sources/capacity.md";
    const targetPath = path.join(rootDir, relativePath);
    const imported = "# Imported\n";
    await fs.writeFile(targetPath, "# Edited before rollback\n", "utf8");
    await seedCreated(relativePath, hash(imported));

    let recreateCount = 0;
    rootControl.afterMove = async (from, to) => {
      if (recreateCount < 32 && from === targetPath && path.basename(to) === "content") {
        recreateCount += 1;
        await fs.writeFile(targetPath, `# Recreated ${recreateCount}\n`, "utf8");
      }
    };

    await expect(rollback()).rejects.toThrow("after 32 concurrent recreations");
    rootControl.afterMove = undefined;
    expect(recreateCount).toBe(32);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("# Recreated 32\n");

    reopenStore(stateDir);
    const interrupted = await readRun();
    expect(interrupted?.createdPaths[0]?.recoveryPaths).toHaveLength(32);
    expect(interrupted?.rollbackTargetsFinalizedAt).toBeUndefined();

    const retried = await rollback();
    expect(retried.alreadyRolledBack).toBe(false);
    expect(retried.preservedPaths).toHaveLength(33);
    expect(new Set(retried.preservedPaths.map((entry) => entry.recoveryPath))).toHaveLength(33);
    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

    reopenStore(stateDir);
    const persisted = await readRun();
    expect(persisted).toMatchObject({
      rollbackStartedAt: expect.any(String),
      rollbackTargetsFinalizedAt: expect.any(String),
      rolledBackAt: expect.any(String),
    });
    expect(persisted?.createdPaths[0]?.recoveryPaths).toHaveLength(33);

    reopenStore(stateDir);
    const repeated = await rollback();
    expect(repeated.alreadyRolledBack).toBe(true);
    expect(repeated.preservedPaths).toStrictEqual(retried.preservedPaths);
  });

  it("queues the whole rollback behind an active vault mutation", async () => {
    const { rootDir, rollback, readRun, seedCreated } = await createRollbackVault("chatgpt-queued");
    const relativePath = "sources/queued.md";
    const targetPath = path.join(rootDir, relativePath);
    const edited = "# Queued edit\n";
    await fs.writeFile(targetPath, edited, "utf8");
    await seedCreated(relativePath, "not-the-edited-content");

    const lockEntered = deferred();
    const releaseLock = deferred();
    const holder = withMemoryWikiVaultMutation(rootDir, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;

    const rollbackQueued = deferred();
    const originalEnqueue = Object.getOwnPropertyDescriptor(KeyedAsyncQueue.prototype, "enqueue")
      ?.value as KeyedAsyncQueue["enqueue"];
    const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue").mockImplementation(function (
      this: KeyedAsyncQueue,
      key,
      task,
      hooks,
    ) {
      rollbackQueued.resolve();
      return originalEnqueue.call(this, key, task, hooks);
    });
    let pendingRollback: ReturnType<typeof rollbackChatGptImportRun> | undefined;
    try {
      pendingRollback = rollback();
      await rollbackQueued.promise;
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(edited);
      await expect(readRun()).resolves.not.toHaveProperty("rolledBackAt");

      releaseLock.resolve();
      await expect(pendingRollback).resolves.toMatchObject({
        alreadyRolledBack: false,
        preservedPaths: [{ path: relativePath }],
      });
      await holder;
    } finally {
      releaseLock.resolve();
      enqueueSpy.mockRestore();
      await Promise.allSettled([holder, ...(pendingRollback ? [pendingRollback] : [])]);
    }
  });

  it("preserves trailing spaces on an updated page before restoring its snapshot", async () => {
    const { rootDir, rollback } = await createRollbackVault("chatgpt-updated-whitespace");
    const runId = "chatgpt-updated-whitespace";
    const relativePath = "sources/updated-whitespace.md";
    const snapshotRelativePath = "snapshots/updated-whitespace.md";
    const targetPath = path.join(rootDir, relativePath);
    const runDir = path.join(rootDir, ".openclaw-wiki", "import-runs", runId);
    const snapshotPath = path.join(runDir, snapshotRelativePath);
    const imported = "# Imported\n";
    const snapshot = "# Before import\n";
    const edited = renderCompiledRelatedPage(imported, "  \n");
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, snapshot, "utf8");
    await fs.writeFile(targetPath, edited, "utf8");
    await seedRollback(rootDir, runId, {
      updatedPaths: [
        {
          path: relativePath,
          snapshotPath: snapshotRelativePath,
          contentHash: hash(imported),
        },
      ],
    });

    const result = await rollback();

    expect(result.restoredCount).toBe(1);
    expect(result.preservedPaths).toHaveLength(1);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(snapshot);
    await expect(
      fs.readFile(path.join(rootDir, result.preservedPaths[0]?.recoveryPath ?? ""), "utf8"),
    ).resolves.toBe(edited);
  });

  it("does not touch targets again after the persisted process-restart fence", async () => {
    const { stateDir, rootDir, config } = await createRollbackVault("chatgpt-finalizing");
    let crashAfterFence = true;
    configureDurableImportRunStore(stateDir, {
      afterWrite: async (record) => {
        if (crashAfterFence && record.rollbackTargetsFinalizedAt && !record.rolledBackAt) {
          crashAfterFence = false;
          expect(compileControl.calls).toBe(0);
          throw new Error("simulated process exit after target fence");
        }
      },
    });
    const relativePath = "sources/finalizing.md";
    const targetPath = path.join(rootDir, relativePath);
    const imported = "# Imported\n";
    const beforeCompile = "# Written after rollback target finalization\n";
    const afterCompilerRead = "# Saved after compiler read\n";
    await fs.writeFile(targetPath, imported, "utf8");
    await seedRollback(rootDir, "chatgpt-finalizing", {
      createdPaths: [{ path: relativePath, contentHash: hash(imported) }],
    });

    await expect(rollbackChatGptImportRun({ config, runId: "chatgpt-finalizing" })).rejects.toThrow(
      "simulated process exit after target fence",
    );
    await expect(
      getMemoryWikiImportRunStateStore().read(rootDir, "chatgpt-finalizing"),
    ).resolves.toMatchObject({
      rollbackStartedAt: expect.any(String),
      rollbackTargetsFinalizedAt: expect.any(String),
    });
    expect(
      (await getMemoryWikiImportRunStateStore().read(rootDir, "chatgpt-finalizing"))?.rolledBackAt,
    ).toBeUndefined();

    await fs.writeFile(targetPath, beforeCompile, "utf8");
    reopenStore(stateDir);
    configureMemoryWikiCompiledCacheStore(undefined);
    configureCompiledCacheStore();
    const realReadFile = fs.readFile;
    const realWriteFile = fs.writeFile;
    rootControl.moves.mockClear();
    let savedAfterRead = false;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const result = await Reflect.apply(realReadFile, fs, args);
      if (
        !savedAfterRead &&
        typeof args[0] === "string" &&
        path.resolve(args[0]) === path.resolve(targetPath)
      ) {
        savedAfterRead = true;
        await realWriteFile(targetPath, afterCompilerRead, "utf8");
      }
      return result;
    });
    let sourceWrites = 0;
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && path.resolve(args[0]) === path.resolve(targetPath)) {
        sourceWrites += 1;
      }
      return await Reflect.apply(realWriteFile, fs, args);
    });
    const result = await rollbackChatGptImportRun({
      config,
      runId: "chatgpt-finalizing",
    });

    expect(savedAfterRead).toBe(true);
    expect(result.alreadyRolledBack).toBe(false);
    expect(
      rootControl.moves.mock.calls.some(([from, to]) => from === targetPath || to === targetPath),
    ).toBe(false);
    expect(sourceWrites).toBe(0);
    await expect(realReadFile(targetPath, "utf8")).resolves.toBe(afterCompilerRead);
    readSpy.mockRestore();
    writeSpy.mockRestore();
    rootControl.afterMove = undefined;
    await expect(
      getMemoryWikiImportRunStateStore().read(rootDir, "chatgpt-finalizing"),
    ).resolves.toMatchObject({
      rollbackStartedAt: expect.any(String),
      rollbackTargetsFinalizedAt: expect.any(String),
      rolledBackAt: expect.any(String),
    });
  });

  it("scans the recovery directory once for a multi-page rollback", async () => {
    const { stateDir, rootDir, rollback } = await createRollbackVault("chatgpt-linear");
    const runId = "chatgpt-linear";
    const imported = "# Imported\n";
    const contentHash = hash(imported);
    const createdPaths = Array.from({ length: 24 }, (_, index) => ({
      path: `sources/linear-${index}.md`,
      contentHash,
    }));
    await Promise.all(
      createdPaths.map(async (entry) => {
        await fs.writeFile(path.join(rootDir, entry.path), imported, "utf8");
      }),
    );
    await seedRollback(rootDir, runId, { createdPaths });
    let rollbackWrites = 0;
    configureDurableImportRunStore(stateDir, {
      beforeWrite: async () => {
        rollbackWrites += 1;
      },
    });
    rootControl.lists.length = 0;

    await expect(rollback()).resolves.toMatchObject({
      removedCount: createdPaths.length,
      preservedPaths: [],
    });
    const recoveryScans = rootControl.lists.flatMap(({ rootDir: listedRoot, calls }) =>
      calls.filter(
        ([relativePath]) =>
          path.resolve(listedRoot, relativePath) ===
          path.join(rootDir, ".openclaw-wiki", "import-runs", runId, "recovered"),
      ),
    );
    expect(recoveryScans).toHaveLength(1);
    expect(rollbackWrites).toBe(3);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked recovery directory without touching external files",
    async () => {
      const stateDir = await createTempDir("memory-wiki-chatgpt-recovery-link-state-");
      const externalDir = await createTempDir("memory-wiki-chatgpt-recovery-link-external-");
      const { rootDir, config } = await createVault({ initialize: true });
      configureDurableImportRunStore(stateDir);
      const runId = "chatgpt-recovery-link";
      const relativePath = "sources/existing.md";
      const snapshotRelativePath = "snapshots/existing.md";
      const imported = "# Imported\n";
      const runDir = path.join(rootDir, ".openclaw-wiki", "import-runs", runId);
      const snapshotPath = path.join(runDir, snapshotRelativePath);
      const targetPath = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, imported, "utf8");
      await fs.writeFile(targetPath, imported, "utf8");
      await seedRollback(rootDir, runId, {
        updatedPaths: [
          {
            path: relativePath,
            snapshotPath: snapshotRelativePath,
            contentHash: hash(imported),
          },
        ],
      });

      const slotPrefix = `updated-0-${hash(relativePath)}-`;
      const externalSlot = path.join(externalDir, `${slotPrefix}ABCDEF`);
      const externalContent = path.join(externalSlot, "content");
      await fs.mkdir(externalSlot);
      await fs.writeFile(externalContent, imported, "utf8");
      await fs.symlink(externalDir, path.join(runDir, "recovered"), "dir");

      await expect(rollbackChatGptImportRun({ config, runId })).rejects.toMatchObject({
        code: "path-alias",
      });
      await expect(fs.readFile(externalContent, "utf8")).resolves.toBe(imported);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(imported);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses symlink, hardlink, and directory targets without touching them",
    async () => {
      const externalDir = await createTempDir("memory-wiki-chatgpt-external-");
      const externalPath = path.join(externalDir, "outside.md");
      await fs.writeFile(externalPath, "# Outside\n", "utf8");

      for (const special of [
        {
          name: "symlink",
          code: "path-alias",
          setup: async (targetPath: string) => {
            await fs.symlink(externalPath, targetPath);
          },
          assertUntouched: async (targetPath: string) => {
            await expect(fs.readlink(targetPath)).resolves.toBe(externalPath);
            await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("# Outside\n");
          },
        },
        {
          name: "hardlink",
          code: "hardlink",
          setup: async (targetPath: string) => {
            const sourcePath = `${targetPath}.source`;
            await fs.writeFile(sourcePath, "# Hardlinked\n", "utf8");
            await fs.link(sourcePath, targetPath);
          },
          assertUntouched: async (targetPath: string) => {
            await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("# Hardlinked\n");
            expect((await fs.lstat(targetPath)).nlink).toBeGreaterThan(1);
          },
        },
        {
          name: "directory",
          code: "invalid-path",
          setup: async (targetPath: string) => {
            await fs.mkdir(targetPath);
            await fs.writeFile(path.join(targetPath, "nested.md"), "# Nested\n", "utf8");
          },
          assertUntouched: async (targetPath: string) => {
            await expect(fs.readFile(path.join(targetPath, "nested.md"), "utf8")).resolves.toBe(
              "# Nested\n",
            );
          },
        },
      ]) {
        const stateDir = await createTempDir(`memory-wiki-chatgpt-${special.name}-state-`);
        const { rootDir, config } = await createVault({ initialize: true });
        configureDurableImportRunStore(stateDir);
        const runId = `chatgpt-${special.name}-target`;
        const relativePath = `sources/${special.name}.md`;
        const targetPath = path.join(rootDir, relativePath);
        await special.setup(targetPath);
        await seedRollback(rootDir, runId, {
          createdPaths: [{ path: relativePath, contentHash: `not-the-${special.name}` }],
        });

        await expect(rollbackChatGptImportRun({ config, runId })).rejects.toMatchObject({
          code: special.code,
        });
        await special.assertUntouched(targetPath);
        const interrupted = await getMemoryWikiImportRunStateStore().read(rootDir, runId);
        expect(interrupted).toMatchObject({
          rollbackStartedAt: expect.any(String),
          createdPaths: [{ path: relativePath }],
        });
        expect(interrupted).not.toHaveProperty("rollbackTargetsFinalizedAt");
        expect(interrupted?.createdPaths[0]).not.toHaveProperty("recoveryPaths");
      }
    },
  );

  it("refuses a file replaced by a directory at the move boundary", async () => {
    const { rootDir, rollback, readRun, seedCreated } =
      await createRollbackVault("chatgpt-directory-swap");
    const relativePath = "sources/swapped.md";
    const targetPath = path.join(rootDir, relativePath);
    const retainedPath = `${targetPath}.retained`;
    await fs.writeFile(targetPath, "# Original\n");
    await seedCreated(relativePath, "changed");
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation) => {
        if (swapped || operation !== "move") {
          return;
        }
        swapped = true;
        await fs.rename(targetPath, retainedPath);
        await fs.mkdir(targetPath);
        await fs.writeFile(path.join(targetPath, "nested.md"), "# Nested\n");
      },
    });

    await expect(rollback()).rejects.toMatchObject({
      code: "invalid-path",
    });
    expect(swapped).toBe(true);
    await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe("# Original\n");
    await expect(fs.readFile(path.join(targetPath, "nested.md"), "utf8")).resolves.toBe(
      "# Nested\n",
    );
    const interrupted = await readRun();
    expect(interrupted).not.toHaveProperty("rollbackTargetsFinalizedAt");
    expect(interrupted?.createdPaths[0]).not.toHaveProperty("recoveryPaths");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a target-parent swap at the move boundary without touching either tree",
    async () => {
      const stateDir = await createTempDir("memory-wiki-chatgpt-parent-swap-state-");
      const externalDir = await createTempDir("memory-wiki-chatgpt-parent-swap-external-");
      const { rootDir, config } = await createVault({ initialize: true });
      configureDurableImportRunStore(stateDir);
      const runId = "chatgpt-parent-swap";
      const relativePath = "sources/swapped.md";
      const sourceDir = path.join(rootDir, "sources");
      const parkedSourceDir = path.join(rootDir, "sources-parked");
      const targetPath = path.join(sourceDir, "swapped.md");
      const parkedTargetPath = path.join(parkedSourceDir, "swapped.md");
      const externalTargetPath = path.join(externalDir, "swapped.md");
      await fs.writeFile(targetPath, "# Internal\n", "utf8");
      await fs.writeFile(externalTargetPath, "# External\n", "utf8");
      await seedRollback(rootDir, runId, {
        createdPaths: [{ path: relativePath, contentHash: "not-the-internal-content" }],
      });

      let swapped = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation) => {
          if (swapped || operation !== "move") {
            return;
          }
          swapped = true;
          await fs.rename(sourceDir, parkedSourceDir);
          await fs.symlink(externalDir, sourceDir, "dir");
        },
      });

      await expect(rollbackChatGptImportRun({ config, runId })).rejects.toMatchObject({
        code: expect.stringMatching(/path-mismatch|path-alias|not-file/),
      });
      expect(swapped).toBe(true);
      await expect(fs.readFile(parkedTargetPath, "utf8")).resolves.toBe("# Internal\n");
      await expect(fs.readFile(externalTargetPath, "utf8")).resolves.toBe("# External\n");
    },
  );
});
