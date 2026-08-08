import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  prepareCodeModeMatrixTaskFixture,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
} from "../../../scripts/code-mode-model-matrix.ts";

const execFileAsync = promisify(execFile);

describe("Code Mode model matrix source provenance", () => {
  it("does not treat its reserved custom output directory as a source mutation", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-source-test-"));
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: repoRoot });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@openclaw.invalid",
          "commit",
          "--allow-empty",
          "--message=initial",
          "--quiet",
        ],
        { cwd: repoRoot },
      );
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(
        configPath,
        `{
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6@openai:matrix", fallbacks: [] },
              models: {
                "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
          auth: {
            profiles: {
              "openai:matrix": { provider: "openai", mode: "api_key" },
            },
          },
        }\n`,
        "utf8",
      );
      await execFileAsync("git", ["add", "matrix.json5"], { cwd: repoRoot });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@openclaw.invalid",
          "commit",
          "--message=matrix-config",
          "--quiet",
        ],
        { cwd: repoRoot },
      );
      let calls = 0;
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          conversationProof: true,
          config: configPath,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "qa-output",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 10,
        },
        {
          buildCliArtifacts: async () => {},
          readBuildSha256: async () => "build",
          readAuthProfile: async () => ({
            credentialEnvName: "OPENAI_API_KEY",
            credentialValue: "sk-matrix-test",
            mode: "api_key",
            present: true,
            provider: "openai",
          }),
          runCell: async ({ buildSha256, cell, configSha256, gitSha, outputDir }) => {
            calls += 1;
            const fixture = await prepareCodeModeMatrixTaskFixture(
              path.join(outputDir, "fixture"),
              cell,
            );
            return {
              buildSha256,
              firstLogicalCallCacheStatus: "unknown",
              codeModeEngaged: true,
              configSha256,
              elapsedMs: 1,
              expected: fixture.expected,
              failureCategory: null,
              final: fixture.expected,
              fixtureSha256: fixture.fixtureSha256,
              gitSha,
              id: cell.id,
              mode: cell.mode,
              model: cell.model,
              observedModel: "gpt-5.6",
              observedProvider: "openai",
              oracle: {
                answer: true,
                effect: true,
                engagement: true,
                identity: true,
                toolExecution: true,
              },
              passed: true,
              promptSha256: fixture.promptSha256,
              repetition: cell.repetition,
              sourceDirty: false,
              sourcePatchSha256: null,
              status: "ok",
              task: cell.task,
              timestamp: "2026-08-06T00:00:00.000Z",
            } satisfies CodeModeMatrixCellResult;
          },
        },
      );

      expect(calls).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.summary).toMatchObject({
        counts: { total: 1, failed: 1 },
        frontierEvidenceAudit: {
          valid: false,
          reasons: ["frontier_receipt_missing_or_invalid"],
        },
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("stops before executing a cell when the frozen source changes", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-drift-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(
        configPath,
        `{
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4@openai:matrix", fallbacks: [] },
              models: {
                "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
          auth: {
            profiles: {
              "openai:matrix": { provider: "openai", mode: "api_key" },
            },
          },
        }\n`,
        "utf8",
      );
      let sourceReads = 0;
      let calls = 0;
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          conversationProof: false,
          config: configPath,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.4"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["read"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          buildCliArtifacts: async () => {},
          readAuthProfile: async () => ({
            credentialEnvName: "OPENAI_API_KEY",
            credentialValue: "test-credential",
            mode: "api_key",
            present: true,
            provider: "openai",
          }),
          readBuildSha256: async () => "build123",
          readSourceIdentity: async () => {
            sourceReads += 1;
            return sourceReads === 1
              ? { gitSha: "abc123", sourceDirty: false, sourcePatchSha256: null }
              : { gitSha: "abc123", sourceDirty: true, sourcePatchSha256: "changed" };
          },
          runCell: async () => {
            calls += 1;
            throw new Error("cell must not execute");
          },
        },
      );

      expect(calls).toBe(0);
      expect(result.exitCode).toBe(1);
      expect(result.summary).toMatchObject({
        counts: { total: 1, failed: 1 },
      });
      const firstResult = JSON.parse(
        (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8")).trim(),
      ) as CodeModeMatrixCellResult;
      expect(firstResult).toMatchObject({
        error: {
          kind: "source_mismatch",
          message: "source_mismatch",
        },
        failureCategory: "proof_drift",
      });
      expect(JSON.stringify(firstResult)).not.toContain("harness_error");
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});
