import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileLockMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  actualAcquire: undefined as
    | typeof import("openclaw/plugin-sdk/file-lock").acquireFileLock
    | undefined,
}));

vi.mock("openclaw/plugin-sdk/file-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-lock")>();
  fileLockMocks.actualAcquire = actual.acquireFileLock;
  return { ...actual, acquireFileLock: fileLockMocks.acquire };
});

import { drainFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import { runQaSuiteEvidenceLifecycle } from "./suite-evidence-lifecycle.js";

const tempRoots: string[] = [];

async function makeTempRepo(label: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), label));
  tempRoots.push(repoRoot);
  return repoRoot;
}

async function makeOutputDir(repoRoot: string, name = "output") {
  const outputDir = path.join(repoRoot, name);
  await fs.mkdir(outputDir, { recursive: true });
  return outputDir;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  const actualAcquire = fileLockMocks.actualAcquire;
  if (!actualAcquire) {
    throw new Error("expected the real file-lock implementation");
  }
  fileLockMocks.acquire.mockReset().mockImplementation(actualAcquire);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await drainFileLockStateForTest();
  await Promise.all(
    tempRoots.splice(0).map((repoRoot) => fs.rm(repoRoot, { recursive: true, force: true })),
  );
});

describe("QA suite evidence lifecycle", () => {
  it("rejects a same-output loser before its callback can mutate evidence", async () => {
    const repoRoot = await makeTempRepo("qa-evidence-lock-same-");
    const outputDir = await makeOutputDir(repoRoot);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const loserRun = vi.fn();
    const firstRun = runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async ({ target }) => {
      await fs.writeFile(target.stagedPath, "first\n", "utf8");
      firstEntered.resolve();
      await releaseFirst.promise;
      return target.canonicalPath;
    });
    await firstEntered.promise;

    await expect(
      runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, loserRun),
    ).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(loserRun).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await expect(firstRun).resolves.toBe(path.join(outputDir, "qa-evidence.json"));
    await expect(fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")).resolves.toBe(
      "first\n",
    );
  });

  it("allows different output directories to stage concurrently", async () => {
    const repoRoot = await makeTempRepo("qa-evidence-lock-different-");
    const outputDirs = await Promise.all([
      makeOutputDir(repoRoot, "one"),
      makeOutputDir(repoRoot, "two"),
    ]);
    const bothEntered = deferred();
    let entered = 0;
    const run = (outputDir: string, value: string) =>
      runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async ({ target }) => {
        await fs.writeFile(target.stagedPath, value, "utf8");
        entered += 1;
        if (entered === 2) {
          bothEntered.resolve();
        }
        await bothEntered.promise;
      });

    await Promise.all([run(outputDirs[0]!, "one"), run(outputDirs[1]!, "two")]);
    await expect(fs.readFile(path.join(outputDirs[0]!, "qa-evidence.json"), "utf8")).resolves.toBe(
      "one",
    );
    await expect(fs.readFile(path.join(outputDirs[1]!, "qa-evidence.json"), "utf8")).resolves.toBe(
      "two",
    );
  });

  it("invalidates stale canonical evidence before planning", async () => {
    const repoRoot = await makeTempRepo("qa-evidence-stale-");
    const outputDir = await makeOutputDir(repoRoot);
    const canonicalPath = path.join(outputDir, "qa-evidence.json");
    await fs.writeFile(canonicalPath, "stale\n", "utf8");
    const planningError = new Error("planning failed");

    await expect(
      runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async () => {
        await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
        throw planningError;
      }),
    ).rejects.toBe(planningError);
    await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes staged evidence before releasing the lifecycle lock", async () => {
    const repoRoot = await makeTempRepo("qa-evidence-publish-");
    const outputDir = await makeOutputDir(repoRoot);
    const events: string[] = [];
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      events.push("publish");
      return await rename(...args);
    });
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      const lock = await actualAcquire(...args);
      return {
        ...lock,
        release: async () => {
          events.push("release");
          await lock.release();
        },
      };
    });

    await runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async ({ target }) => {
      events.push("stage");
      await fs.writeFile(target.stagedPath, "candidate\n", "utf8");
    });

    expect(events).toEqual(["stage", "publish", "release"]);
  });

  it("keeps the run failure primary when discard and release also fail", async () => {
    const repoRoot = await makeTempRepo("qa-evidence-errors-");
    const outputDir = await makeOutputDir(repoRoot);
    const runError = new Error("run failed");
    const discardError = new Error("discard failed");
    const releaseError = new Error("release failed");
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
      if (String(targetPath).endsWith(".staged")) {
        throw discardError;
      }
      return await rm(targetPath, options);
    });
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      const lock = await actualAcquire(...args);
      return {
        ...lock,
        release: async () => {
          await lock.release();
          throw releaseError;
        },
      };
    });

    const thrown = await runQaSuiteEvidenceLifecycle(
      { repoRoot, outputDir },
      async ({ target }) => {
        await fs.writeFile(target.stagedPath, "candidate\n", "utf8");
        throw runError;
      },
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      cause: runError,
      errors: [runError, discardError, releaseError],
    });
  });

  it("discards after publish failure and releases last", async () => {
    const repoRoot = await makeTempRepo("qa-evidence-publish-failure-");
    const outputDir = await makeOutputDir(repoRoot);
    const publishError = new Error("publish failed");
    const releaseError = new Error("release failed");
    const events: string[] = [];
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      events.push("publish");
      throw publishError;
    });
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
      if (String(targetPath).endsWith(".staged")) {
        events.push("discard");
      }
      return await rm(targetPath, options);
    });
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      const lock = await actualAcquire(...args);
      return {
        ...lock,
        release: async () => {
          events.push("release");
          await lock.release();
          throw releaseError;
        },
      };
    });

    const thrown = await runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async ({ target }) =>
      fs.writeFile(target.stagedPath, "candidate\n", "utf8"),
    ).catch((error: unknown) => error);

    expect(events).toEqual(["publish", "discard", "release"]);
    expect(thrown).toMatchObject({ cause: publishError, errors: [publishError, releaseError] });
  });

  it("keeps published canonical evidence when post-publish release fails", async () => {
    const repoRoot = await makeTempRepo("qa-evidence-release-failure-");
    const outputDir = await makeOutputDir(repoRoot);
    const releaseError = new Error("release failed after publish");
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      const lock = await actualAcquire(...args);
      return {
        ...lock,
        release: async () => {
          await lock.release();
          throw releaseError;
        },
      };
    });

    await expect(
      runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async ({ target }) => {
        await fs.writeFile(target.stagedPath, "published\n", "utf8");
      }),
    ).rejects.toBe(releaseError);
    await expect(fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")).resolves.toBe(
      "published\n",
    );
  });
});
