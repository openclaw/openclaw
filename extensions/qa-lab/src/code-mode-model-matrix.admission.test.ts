import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCodeModeMatrixOptions,
  reserveCodeModeMatrixOutputDir,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
  type CodeModeMatrixOptions,
  type MatrixCell,
} from "../../../scripts/code-mode-model-matrix.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function matrixOptions(
  repoRoot: string,
  overrides: Partial<CodeModeMatrixOptions>,
): CodeModeMatrixOptions {
  return {
    ...parseCodeModeMatrixOptions(["--model", "fixture/model"], repoRoot),
    tasks: ["read"],
    modes: ["direct", "code"],
    repetitions: 1,
    ...overrides,
  };
}

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
  it("settles admitted pairs before an auth failure stops its provider", async () => {
    const root = tempDirs.make("openclaw-matrix-provider-stop-");
    const requested: string[] = [];
    const result = await runCodeModeModelMatrix(
      matrixOptions(root, {
        models: ["openai/first", "openai/second", "google/third"],
        concurrency: 1,
      }),
      {
        readGitSha: async () => "synthetic-source",
        readBuildSha256: async () => "synthetic-build",
        buildCliArtifacts: async () => {},
        runCell: async ({ cell }) => {
          requested.push(cell.model);
          return scheduledResult(cell, cell.model === "openai/first" ? "provider_auth" : null);
        },
      },
    );
    expect(requested.filter((model) => model === "openai/first")).toHaveLength(2);
    expect(requested.filter((model) => model === "openai/second")).toHaveLength(0);
    expect(requested.filter((model) => model === "google/third")).toHaveLength(2);
    expect(result.exitCode).toBe(1);
  });
});

describe("Code Mode model matrix runtime and output admission", () => {
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
});
