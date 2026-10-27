import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  reserveCodeModeMatrixOutputDir,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
  type MatrixCell,
} from "../../../scripts/code-mode-model-matrix.ts";
import {
  matrixDependencies,
  matrixOptions,
  matrixResult,
} from "./code-mode-model-matrix.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function scheduledResult(
  cell: MatrixCell,
  failureCategory: CodeModeMatrixCellResult["failureCategory"] = null,
): CodeModeMatrixCellResult {
  return matrixResult(cell, {
    final: failureCategory ? "" : "ok",
    failureCategory,
    passed: failureCategory === null,
    status: failureCategory ? "error" : "ok",
    oracle: {
      answer: !failureCategory,
      effect: !failureCategory,
      engagement: true,
      identity: true,
      toolExecution: true,
    },
    usage: { input: 8, output: 2, total: 10 },
    costUsd: 0.1,
  });
}

describe("Code Mode matrix paired admission", () => {
  it.each(["code", "auto"] as const)(
    "counterbalances the complete direct/%s schedule",
    async (mode) => {
      const root = tempDirs.make("openclaw-matrix-mode-order-");
      const started: string[] = [];
      const result = await runCodeModeModelMatrix(
        matrixOptions(root, {
          modes: ["direct", mode],
          repetitions: 2,
          concurrency: 1,
          maxCells: 4,
        }),
        matrixDependencies({
          runCell: async ({ cell }) => {
            started.push(`${cell.mode}:${cell.repetition}`);
            return scheduledResult(cell);
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(started).toEqual(["direct:1", `${mode}:1`, `${mode}:2`, "direct:2"]);
    },
  );

  it.each([
    { limit: { maxCells: 3 }, reason: "max_cells", mode: "code" },
    { limit: { maxTokens: 15 }, reason: "max_tokens", mode: "code" },
    { limit: { maxCells: 3 }, reason: "max_cells", mode: "auto" },
    { limit: { maxTokens: 15 }, reason: "max_tokens", mode: "auto" },
  ] as const)(
    "settles the declared $mode pair before $reason stops the next wave",
    async ({ limit, reason, mode }) => {
      const root = tempDirs.make("openclaw-matrix-admission-");
      const schedule = path.join(root, "schedule.json");
      await fs.writeFile(
        schedule,
        JSON.stringify([
          { model: "fixture/model", task: "read", repetition: 1, firstMode: mode },
          { model: "fixture/model", task: "read", repetition: 2, firstMode: "direct" },
        ]),
      );
      const started: string[] = [];
      const { promise: pairReady, resolve: release } = Promise.withResolvers<void>();
      const result = await runCodeModeModelMatrix(
        matrixOptions(root, {
          modes: ["direct", mode],
          schedulePath: schedule,
          repetitions: 2,
          concurrency: 2,
          ...limit,
        }),
        matrixDependencies({
          runCell: async ({ cell }) => {
            started.push(cell.mode);
            if (started.length === 2) {
              release?.();
            }
            await pairReady;
            return scheduledResult(cell);
          },
        }),
      );
      expect(started).toEqual([mode, "direct"]);
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

  it.each([
    { category: "provider_auth", concurrency: 1 },
    { category: "provider_billing", concurrency: 2 },
    { category: "model_unavailable", concurrency: 1 },
  ] as const)(
    "settles admitted pairs before $category stops its scope at concurrency $concurrency",
    async ({ category, concurrency }) => {
      const root = tempDirs.make("openclaw-matrix-provider-stop-");
      const requested: string[] = [];
      const result = await runCodeModeModelMatrix(
        matrixOptions(root, {
          modes: ["direct", "code"],
          models: ["openai/first", "openai/second", "google/third"],
          concurrency,
        }),
        matrixDependencies({
          runCell: async ({ cell }) => {
            requested.push(cell.model);
            return scheduledResult(cell, cell.model === "openai/first" ? category : null);
          },
        }),
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
    const options = matrixOptions(root, {
      repetitions: 2,
      outputDir: "artifacts/build-drift",
    });
    await expect(
      runCodeModeModelMatrix(
        options,
        matrixDependencies({
          readBuildSha256: () => fs.readFile(artifact, "utf8"),
          runCell: async ({ cell, buildSha256 }) => {
            dispatched.push(cell.id);
            await fs.writeFile(artifact, "changed");
            return { ...scheduledResult(cell), buildSha256 };
          },
        }),
      ),
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
    const options = matrixOptions(root, {
      modes: ["direct", "code"],
      runtimeDir: root,
      outputDir: "artifacts/frozen",
      dryRun: true,
    });
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
    const repoRoot = tempDirs.make("openclaw-code-mode-output-test-");
    const existing = path.join(repoRoot, "existing");
    await fs.mkdir(existing);
    await expect(reserveCodeModeMatrixOutputDir(repoRoot, existing)).rejects.toThrow(
      "must not already exist",
    );

    const outside = tempDirs.make("openclaw-code-mode-outside-test-");
    const linked = path.join(repoRoot, "linked");
    await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(
      reserveCodeModeMatrixOutputDir(repoRoot, path.join(linked, "results")),
    ).rejects.toThrow("must not traverse symlinks");
  });

  it("allows only one concurrent run to reserve an output path", async () => {
    const repoRoot = tempDirs.make("openclaw-code-mode-reserve-test-");
    const outputDir = path.join(repoRoot, "nested", "results");
    const attempts = await Promise.allSettled([
      reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
      reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        message: expect.stringContaining("must not already exist"),
      },
    });
  });
});
