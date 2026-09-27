// Code Mode model matrix admission tests cover scheduling and output safety.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCodeModeMatrixOptions,
  reserveCodeModeMatrixOutputDir,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
  type MatrixCell,
} from "../../../scripts/code-mode-model-matrix.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function scheduledResult(
  cell: MatrixCell,
  failureCategory: CodeModeMatrixCellResult["failureCategory"] = null,
): CodeModeMatrixCellResult {
  return {
    ...cell,
    buildSha256: "synthetic-build",
    gitSha: "synthetic-source",
    sourceDirty: false,
    sourcePatchSha256: null,
    codeModeEngaged: cell.mode === "code",
    elapsedMs: 1,
    expected: "ok",
    final: failureCategory ? "" : "ok",
    failureCategory,
    observedModel: cell.model.split("/")[1]!,
    observedProvider: cell.model.split("/")[0]!,
    passed: failureCategory === null,
    status: failureCategory ? "error" : "ok",
    oracle: {
      answer: !failureCategory,
      effect: !failureCategory,
      engagement: true,
      identity: true,
      toolExecution: true,
    },
    timestamp: "2026-09-21T12:00:00.000Z",
    usage: { input: 8, output: 2, total: 10 },
    costUsd: 0.1,
  };
}

describe("Code Mode matrix paired admission", () => {
  it.each([
    { flag: "--max-cells", value: "3", reason: "max_cells" },
    { flag: "--max-tokens", value: "15", reason: "max_tokens" },
  ])(
    "settles the declared pair before $reason stops the next wave",
    async ({ flag, value, reason }) => {
      const root = tempDirs.make("openclaw-matrix-admission-");
      const schedule = path.join(root, "schedule.json");
      await fs.writeFile(
        schedule,
        JSON.stringify([
          { model: "fixture/model", task: "read", repetition: 1, firstMode: "code" },
          { model: "fixture/model", task: "read", repetition: 2, firstMode: "direct" },
        ]),
      );
      const started: string[] = [];
      let release: (() => void) | undefined;
      const pairReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      const result = await runCodeModeModelMatrix(
        parseCodeModeMatrixOptions(
          [
            "--model",
            "fixture/model",
            "--task",
            "read",
            "--mode",
            "direct",
            "--mode",
            "code",
            "--schedule",
            schedule,
            "--repetitions",
            "2",
            "--concurrency",
            "2",
            flag,
            value,
          ],
          root,
        ),
        {
          readGitSha: async () => "synthetic-source",
          readBuildSha256: async () => "synthetic-build",
          buildCliArtifacts: async () => {},
          runCell: async ({ cell }) => {
            started.push(cell.mode);
            if (started.length === 2) {
              release?.();
            }
            await pairReady;
            return scheduledResult(cell);
          },
        },
      );
      expect(started).toEqual(["code", "direct"]);
      expect(result.exitCode).toBe(1);
      expect(result.summary).toMatchObject({
        admission: {
          admittedCells: 2,
          completedCells: 2,
          stopReason: reason,
          unstarted: [{ reason }, { reason }],
          observed: { tokens: 20 },
        },
      });
    },
  );

  it.each(
    (["provider_auth", "provider_billing", "model_unavailable"] as const).flatMap((category) =>
      [1, 2].map((concurrency) => ({ category, concurrency })),
    ),
  )(
    "settles admitted pairs before $category stops its scope at concurrency $concurrency",
    async ({ category, concurrency }) => {
      const root = tempDirs.make("openclaw-matrix-provider-stop-");
      const requested: string[] = [];
      const result = await runCodeModeModelMatrix(
        parseCodeModeMatrixOptions(
          [
            "--model",
            "openai/first",
            "--model",
            "openai/second",
            "--model",
            "google/third",
            "--task",
            "read",
            "--mode",
            "direct",
            "--mode",
            "code",
            "--repetitions",
            "1",
            "--concurrency",
            String(concurrency),
          ],
          root,
        ),
        {
          readGitSha: async () => "synthetic-source",
          readBuildSha256: async () => "synthetic-build",
          buildCliArtifacts: async () => {},
          runCell: async ({ cell }) => {
            requested.push(cell.model);
            return scheduledResult(cell, cell.model === "openai/first" ? category : null);
          },
        },
      );
      expect(requested.filter((model) => model === "openai/first")).toHaveLength(2);
      expect(requested.filter((model) => model === "openai/second")).toHaveLength(
        category === "model_unavailable" ? 2 : 0,
      );
      expect(requested.filter((model) => model === "google/third")).toHaveLength(2);
      expect(result.exitCode).toBe(1);
    },
  );
});

describe("Code Mode model matrix runtime and output admission", () => {
  it("stops after a wave changes built artifacts and retains its original observation", async () => {
    const root = tempDirs.make("openclaw-code-mode-build-drift-");
    const artifact = path.join(root, "entry.js");
    await fs.writeFile(artifact, "original");
    const dispatched: string[] = [];
    const options = parseCodeModeMatrixOptions(
      [
        "--model",
        "openai/fixture",
        "--task",
        "read",
        "--mode",
        "code",
        "--repetitions",
        "2",
        "--output-dir",
        "artifacts/build-drift",
      ],
      root,
    );
    await expect(
      runCodeModeModelMatrix(options, {
        readGitSha: async () => "synthetic-source",
        readBuildSha256: async () =>
          createHash("sha256")
            .update(await fs.readFile(artifact))
            .digest("hex"),
        buildCliArtifacts: async () => {},
        runCell: async ({ cell, buildSha256 }) => {
          dispatched.push(cell.id);
          await fs.writeFile(artifact, "changed");
          return { ...scheduledResult(cell), buildSha256 };
        },
      }),
    ).rejects.toThrow("Runtime build changed");
    expect(dispatched).toHaveLength(1);
    const output = path.join(root, "artifacts/build-drift");
    const rows = (await fs.readFile(path.join(output, "results.jsonl"), "utf8")).trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!).id).toBe(dispatched[0]);
    await expect(fs.stat(path.join(output, "mode-comparison.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a dirty frozen runtime before building or dispatching any model", async () => {
    const root = tempDirs.make("openclaw-code-mode-frozen-runtime-");
    const options = parseCodeModeMatrixOptions(
      [
        "--model",
        "openai/gpt-5.6-luna",
        "--runtime-dir",
        root,
        "--output-dir",
        "artifacts/frozen",
        "--dry-run",
      ],
      root,
    );
    await expect(
      runCodeModeModelMatrix(options, {
        readSourceIdentity: async () => ({
          gitSha: "dirty",
          sourceDirty: true,
          sourcePatchSha256: "patch",
        }),
        buildCliArtifacts: async () => {
          throw new Error("must not build a frozen runtime");
        },
        runCell: async () => {
          throw new Error("must not dispatch a dirty runtime");
        },
      }),
    ).rejects.toThrow("clean committed checkout");
    await expect(fs.stat(path.join(root, "artifacts/frozen"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reserves a fresh output path without symlink traversal", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-output-test-"));
    try {
      const existing = path.join(repoRoot, "existing");
      await fs.mkdir(existing);
      await expect(reserveCodeModeMatrixOutputDir(repoRoot, existing)).rejects.toThrow(
        "must not already exist",
      );

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-outside-test-"));
      const linked = path.join(repoRoot, "linked");
      await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(
        reserveCodeModeMatrixOutputDir(repoRoot, path.join(linked, "results")),
      ).rejects.toThrow("must not traverse symlinks");
      await fs.rm(outside, { force: true, recursive: true });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("allows only one concurrent run to reserve an output path", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-reserve-test-"));
    try {
      const outputDir = path.join(repoRoot, "nested", "results");
      const attempts = await Promise.allSettled([
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
      ]);

      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("must not already exist"),
        }),
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});
