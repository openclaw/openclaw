import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
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
import { createMemoryWikiTestHarness, observeKeyedQueueEnqueue } from "./test-helpers.js";

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
      rootControl.lists.push({ rootDir: vault.rootDir, calls: vi.spyOn(vault, "list").mock.calls });
      return vault;
    },
  };
});

vi.mock("./compile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compile.js")>();
  return {
    ...actual,
    compileMemoryWikiVault: (...args: Parameters<typeof actual.compileMemoryWikiVault>) => {
      compileControl.calls++;
      return actual.compileMemoryWikiVault(...args);
    },
  };
});

const { configureCompiledCacheStore, createTempDir, createVault } = createMemoryWikiTestHarness();
const imported = "# Imported\n";
const finalized = {
  rollbackStartedAt: expect.any(String),
  rollbackTargetsFinalizedAt: expect.any(String),
  rolledBackAt: expect.any(String),
};

function configureDurableImportRunStore(
  stateDir: string,
  afterWrite?: (record: ChatGptImportRunRecord) => Promise<void>,
): void {
  const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const store = createMemoryWikiImportRunStateStore(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
  );
  configureMemoryWikiImportRunStateStore(
    afterWrite
      ? {
          ...store,
          async write(vaultRoot, record) {
            await store.write(vaultRoot, record);
            await afterWrite(record);
          },
        }
      : store,
  );
}

async function createRollbackVault(initialize = true) {
  const runId = "chatgpt-rollback";
  const stateDir = await createTempDir("memory-wiki-chatgpt-state-");
  const vault = await createVault({ initialize });
  configureDurableImportRunStore(stateDir);
  const relativePath = "sources/target.md";
  const targetPath = path.join(vault.rootDir, relativePath);
  const runDir = path.join(vault.rootDir, ".openclaw-wiki", "import-runs", runId);
  async function seed({
    createdPaths = [],
    updatedPaths = [],
  }: Partial<Pick<ChatGptImportRunRecord, "createdPaths" | "updatedPaths">>): Promise<void> {
    await getMemoryWikiImportRunStateStore().write(vault.rootDir, {
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

  return {
    stateDir,
    ...vault,
    relativePath,
    targetPath,
    runDir,
    seed,
    rollback: () => rollbackChatGptImportRun({ config: vault.config, runId }),
    readRun: () => getMemoryWikiImportRunStateStore().read(vault.rootDir, runId),
    readRecovery: (recoveryPath: string) =>
      fs.readFile(path.join(vault.rootDir, recoveryPath), "utf8"),
    reopen: () => {
      resetPluginStateStoreForTests();
      configureDurableImportRunStore(stateDir);
    },
    seedCreated: (contentHash = hash(imported)) =>
      seed({ createdPaths: [{ path: relativePath, contentHash }] }),
    seedUpdated: async (snapshot: string, content = imported) => {
      const snapshotRelativePath = "snapshots/target.md";
      const snapshotPath = path.join(runDir, snapshotRelativePath);
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, snapshot, "utf8");
      await fs.writeFile(targetPath, content, "utf8");
      await seed({
        updatedPaths: [
          { path: relativePath, snapshotPath: snapshotRelativePath, contentHash: hash(imported) },
        ],
      });
    },
  };
}

async function expectText(file: string, expected: string) {
  await expect(fs.readFile(file, "utf8")).resolves.toBe(expected);
}

function beforeNextMove(effect: () => Promise<void>) {
  const swap = vi.fn(effect);
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation: async (operation) => {
      if (operation === "move" && swap.mock.calls.length === 0) {
        await swap();
      }
    },
  });
  return swap;
}

function hash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
  it("reconciles a crash after rename across a real SQLite reopen", async () => {
    const run = await createRollbackVault();
    const { targetPath, relativePath } = run;
    const edited = "# Edited after import\n";
    const recreated = "# Recreated before fence\n";
    await fs.writeFile(targetPath, edited, "utf8");
    await run.seedCreated();

    rootControl.afterMove = async (from, to) => {
      expect(from).toBe(targetPath);
      expect(path.basename(to)).toBe("content");
      rootControl.afterMove = undefined;
      await expect(run.readRun()).resolves.toMatchObject({ rollbackStartedAt: expect.any(String) });
      await fs.writeFile(from, recreated, "utf8");
      throw new Error("simulated process crash after rename");
    };
    await expect(run.rollback()).rejects.toThrow("simulated process crash");
    await expectText(targetPath, recreated);
    run.reopen();
    const retried = await run.rollback();
    expect(retried.alreadyRolledBack).toBe(false);
    expect(retried.preservedPaths).toHaveLength(2);
    const preserved = retried.preservedPaths[0];
    const preservedContents = await Promise.all(
      retried.preservedPaths.map((entry) => run.readRecovery(entry.recoveryPath)),
    );
    expect(preservedContents).toEqual(expect.arrayContaining([edited, recreated]));

    await fs.writeFile(path.join(run.rootDir, preserved?.recoveryPath ?? ""), imported, "utf8");
    run.reopen();
    rootControl.moves.mockClear();
    const fileSpies = (["mkdtemp", "rmdir"] as const).map((method) => vi.spyOn(fs, method));
    const remove = vi.spyOn(fs, "rm");
    const compileCalls = compileControl.calls;
    const repeated = await run.rollback();
    expect(repeated.alreadyRolledBack).toBe(true);
    expect(repeated.preservedPaths).toStrictEqual(retried.preservedPaths);
    [rootControl.moves, ...fileSpies].forEach((spy) => expect(spy).not.toHaveBeenCalled());
    // Releasing coordination may remove its sidecar, but never rollback data.
    for (const [target] of remove.mock.calls) {
      expect(target).toBe(path.join(run.rootDir, ".openclaw-wiki", "mutation.lock"));
    }
    expect(compileControl.calls).toBe(compileCalls);
    await expectText(path.join(run.rootDir, preserved?.recoveryPath ?? ""), imported);
    await expect(run.readRun()).resolves.toMatchObject({
      ...finalized,
      createdPaths: [
        {
          path: relativePath,
          recoveryPaths: retried.preservedPaths.map((entry) => entry.recoveryPath),
        },
      ],
    });
  });

  it("persists 32 recovery slots before retrying and preserving the 33rd target", async () => {
    const { targetPath, rollback, readRun, seedCreated, reopen } = await createRollbackVault();
    await fs.writeFile(targetPath, "# Edited before rollback\n", "utf8");
    await seedCreated();

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
    await expectText(targetPath, "# Recreated 32\n");

    reopen();
    const interrupted = await readRun();
    expect(interrupted?.createdPaths[0]?.recoveryPaths).toHaveLength(32);
    expect(interrupted?.rollbackTargetsFinalizedAt).toBeUndefined();

    const retried = await rollback();
    expect(retried.alreadyRolledBack).toBe(false);
    expect(retried.preservedPaths).toHaveLength(33);
    expect(new Set(retried.preservedPaths.map((entry) => entry.recoveryPath))).toHaveLength(33);
    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

    reopen();
    const persisted = await readRun();
    expect(persisted).toMatchObject(finalized);
    expect(persisted?.createdPaths[0]?.recoveryPaths).toHaveLength(33);
  });

  it("queues the whole rollback behind an active vault mutation", async () => {
    const { rootDir, targetPath, relativePath, rollback, readRun, seedCreated } =
      await createRollbackVault();
    const edited = "# Queued edit\n";
    await fs.writeFile(targetPath, edited, "utf8");
    await seedCreated("not-the-edited-content");

    const lockEntered = deferred();
    const releaseLock = deferred();
    const holder = withMemoryWikiVaultMutation(rootDir, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;

    const rollbackQueued = deferred();
    const enqueueSpy = observeKeyedQueueEnqueue(() => rollbackQueued.resolve());
    let pendingRollback: ReturnType<typeof rollbackChatGptImportRun> | undefined;
    try {
      pendingRollback = rollback();
      await rollbackQueued.promise;
      await expectText(targetPath, edited);
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
    const { targetPath, rollback, readRecovery, seedUpdated } = await createRollbackVault();
    const snapshot = "# Before import\n";
    const edited = `${imported.trimEnd()}\n\n## Related\n${WIKI_RELATED_START_MARKER}\n- No related pages yet.\n${WIKI_RELATED_END_MARKER}\n  \n`;
    await seedUpdated(snapshot, edited);

    const result = await rollback();

    expect(result.restoredCount).toBe(1);
    expect(result.preservedPaths).toHaveLength(1);
    await expectText(targetPath, snapshot);
    await expect(readRecovery(result.preservedPaths[0]?.recoveryPath ?? "")).resolves.toBe(edited);
  });

  it("persists before initialization and never retouches targets after the restart fence", async () => {
    const { stateDir, rootDir, targetPath, rollback, readRun, seedCreated, reopen } =
      await createRollbackVault(false);
    let crashAfterFence = true;
    configureDurableImportRunStore(stateDir, async (record) => {
      if (crashAfterFence && record.rollbackTargetsFinalizedAt && !record.rolledBackAt) {
        crashAfterFence = false;
        expect(compileControl.calls).toBe(0);
        throw new Error("simulated process exit after target fence");
      }
    });
    const beforeCompile = "# Written after rollback target finalization\n";
    const afterCompilerRead = "# Saved after compiler read\n";
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, imported, "utf8");
    await seedCreated();
    const realMkdir = fs.mkdir;
    let checkedInitialization = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (!checkedInitialization && path.resolve(String(args[0])) === path.resolve(rootDir)) {
        checkedInitialization = true;
        await expect(readRun()).resolves.toMatchObject({ rollbackStartedAt: expect.any(String) });
      }
      return await Reflect.apply(realMkdir, fs, args);
    });

    await expect(rollback()).rejects.toThrow("simulated process exit after target fence");
    expect(checkedInitialization).toBe(true);
    await expect(readRun()).resolves.toMatchObject({
      rollbackStartedAt: expect.any(String),
      rollbackTargetsFinalizedAt: expect.any(String),
    });
    expect((await readRun())?.rolledBackAt).toBeUndefined();

    await fs.writeFile(targetPath, beforeCompile, "utf8");
    reopen();
    configureMemoryWikiCompiledCacheStore(undefined);
    configureCompiledCacheStore();
    const realReadFile = fs.readFile;
    const realWriteFile = fs.writeFile;
    rootControl.moves.mockClear();
    let savedAfterRead = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
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
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && path.resolve(args[0]) === path.resolve(targetPath)) {
        sourceWrites += 1;
      }
      return await Reflect.apply(realWriteFile, fs, args);
    });
    const result = await rollback();

    expect(savedAfterRead).toBe(true);
    expect(result.alreadyRolledBack).toBe(false);
    expect(
      rootControl.moves.mock.calls.some(([from, to]) => from === targetPath || to === targetPath),
    ).toBe(false);
    expect(sourceWrites).toBe(0);
    await expect(realReadFile(targetPath, "utf8")).resolves.toBe(afterCompilerRead);
    await expect(readRun()).resolves.toMatchObject(finalized);
  });

  it("scans recovery once with bounded writes for a multi-page rollback", async () => {
    const { stateDir, rootDir, runDir, seed, rollback } = await createRollbackVault();
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
    await seed({ createdPaths });
    let writes = 0;
    configureDurableImportRunStore(stateDir, async () => {
      writes += 1;
    });
    rootControl.lists.length = 0;

    await expect(rollback()).resolves.toMatchObject({
      removedCount: createdPaths.length,
      preservedPaths: [],
    });
    expect(
      rootControl.lists.flatMap(({ rootDir: root, calls }) =>
        calls.filter(
          ([relative]) => path.resolve(root, relative) === path.join(runDir, "recovered"),
        ),
      ),
    ).toHaveLength(1);
    expect(writes).toBe(3);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked recovery directory without touching external files",
    async () => {
      const externalDir = await createTempDir("memory-wiki-chatgpt-recovery-link-external-");
      const { runDir, relativePath, targetPath, rollback, seedUpdated } =
        await createRollbackVault();
      await seedUpdated(imported);

      const slotPrefix = `updated-0-${hash(relativePath)}-`;
      const externalSlot = path.join(externalDir, `${slotPrefix}ABCDEF`);
      const externalContent = path.join(externalSlot, "content");
      await fs.mkdir(externalSlot);
      await fs.writeFile(externalContent, imported, "utf8");
      await fs.symlink(externalDir, path.join(runDir, "recovered"), "dir");

      await expect(rollback()).rejects.toMatchObject({ code: "path-alias" });
      await expectText(externalContent, imported);
      await expectText(targetPath, imported);
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["symlink", "path-alias"],
    ["hardlink", "hardlink"],
    ["directory", "invalid-path"],
  ] as const)("refuses %s targets without touching them", async (special, code) => {
    const externalPath = path.join(
      await createTempDir("memory-wiki-chatgpt-external-"),
      "outside.md",
    );
    const { targetPath, relativePath, rollback, readRun, seedCreated } =
      await createRollbackVault();
    if (special === "symlink") {
      await fs.writeFile(externalPath, "# Outside\n", "utf8");
      await fs.symlink(externalPath, targetPath);
    } else if (special === "hardlink") {
      await fs.writeFile(`${targetPath}.source`, "# Hardlinked\n", "utf8");
      await fs.link(`${targetPath}.source`, targetPath);
    } else {
      await fs.mkdir(targetPath);
      await fs.writeFile(path.join(targetPath, "nested.md"), "# Nested\n", "utf8");
    }
    await seedCreated(`not-the-${special}`);
    await expect(rollback()).rejects.toMatchObject({ code });
    if (special === "symlink") {
      await expect(fs.readlink(targetPath)).resolves.toBe(externalPath);
      await expectText(externalPath, "# Outside\n");
    } else if (special === "hardlink") {
      await expectText(targetPath, "# Hardlinked\n");
      expect((await fs.lstat(targetPath)).nlink).toBeGreaterThan(1);
    } else {
      await expectText(path.join(targetPath, "nested.md"), "# Nested\n");
    }
    const interrupted = await readRun();
    expect(interrupted).toMatchObject({
      rollbackStartedAt: expect.any(String),
      createdPaths: [{ path: relativePath }],
    });
    expect(interrupted).not.toHaveProperty("rollbackTargetsFinalizedAt");
    expect(interrupted?.createdPaths[0]).not.toHaveProperty("recoveryPaths");
  });

  it("refuses a file replaced by a directory at the move boundary", async () => {
    const { targetPath, rollback, readRun, seedCreated } = await createRollbackVault();
    const retainedPath = `${targetPath}.retained`;
    await fs.writeFile(targetPath, "# Original\n");
    await seedCreated("changed");
    const swap = beforeNextMove(async () => {
      await fs.rename(targetPath, retainedPath);
      await fs.mkdir(targetPath);
      await fs.writeFile(path.join(targetPath, "nested.md"), "# Nested\n");
    });

    await expect(rollback()).rejects.toMatchObject({ code: "invalid-path" });
    expect(swap).toHaveBeenCalledOnce();
    await expectText(retainedPath, "# Original\n");
    await expectText(path.join(targetPath, "nested.md"), "# Nested\n");
    const interrupted = await readRun();
    expect(interrupted).not.toHaveProperty("rollbackTargetsFinalizedAt");
    expect(interrupted?.createdPaths[0]).not.toHaveProperty("recoveryPaths");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a target-parent swap at the move boundary without touching either tree",
    async () => {
      const externalDir = await createTempDir("memory-wiki-chatgpt-parent-swap-external-");
      const { rootDir, targetPath, rollback, seedCreated } = await createRollbackVault();
      const sourceDir = path.join(rootDir, "sources");
      const parkedSourceDir = path.join(rootDir, "sources-parked");
      const parkedTargetPath = path.join(parkedSourceDir, path.basename(targetPath));
      const externalTargetPath = path.join(externalDir, path.basename(targetPath));
      await fs.writeFile(targetPath, "# Internal\n", "utf8");
      await fs.writeFile(externalTargetPath, "# External\n", "utf8");
      await seedCreated("not-the-internal-content");

      const swap = beforeNextMove(async () => {
        await fs.rename(sourceDir, parkedSourceDir);
        await fs.symlink(externalDir, sourceDir, "dir");
      });

      await expect(rollback()).rejects.toMatchObject({
        code: expect.stringMatching(/path-mismatch|path-alias|not-file/),
      });
      expect(swap).toHaveBeenCalledOnce();
      await expectText(parkedTargetPath, "# Internal\n");
      await expectText(externalTargetPath, "# External\n");
    },
  );
});
