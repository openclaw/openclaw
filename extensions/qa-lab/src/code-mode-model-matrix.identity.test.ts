import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCodeModeModelMatrix } from "../../../scripts/code-mode-model-matrix.ts";
import {
  frozenFrontierConfig,
  matrixFrontierAuthProfile,
  validFrontierCellResult,
} from "./code-mode-model-matrix.test-helpers.js";

describe("Code Mode matrix frozen identity", () => {
  it.each([
    ["source", "source_mismatch"],
    ["config", "config_mismatch"],
    ["build", "build_mismatch"],
    ["policy", "policy_mismatch"],
  ] as const)("blocks %s drift after preserving sidecar observations", async (kind, reason) => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-identity-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenFrontierConfig, "utf8");
      let sidecarCompleted = false;
      let clock = 0;
      const runConversationProof = vi.fn(async () => {
        if (kind === "config") {
          await fs.appendFile(configPath, "\n", "utf8");
        }
        sidecarCompleted = true;
        return {
          status: "pass" as const,
          counts: { total: 2, passed: 2, failed: 0 },
          cells: [{ id: "observed-sidecar-cell" }],
        };
      });

      const result = await runCodeModeModelMatrix(
        {
          allowFailures: true,
          config: configPath,
          conversationProof: true,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 10,
        },
        {
          buildCliArtifacts: async () => {},
          nowMs: () => {
            clock += 10;
            return clock;
          },
          readAuthProfile: matrixFrontierAuthProfile,
          readBuildSha256: async () =>
            sidecarCompleted && kind === "build" ? "build-drift" : "build123",
          readPolicySha256: async (policyPath) =>
            sidecarCompleted && kind === "policy"
              ? "0".repeat(64)
              : createHash("sha256")
                  .update(await fs.readFile(policyPath))
                  .digest("hex"),
          readSourceIdentity: async () =>
            sidecarCompleted && kind === "source"
              ? {
                  gitSha: "abc123",
                  sourceDirty: true,
                  sourcePatchSha256: "source-drift",
                }
              : {
                  gitSha: "abc123",
                  sourceDirty: false,
                  sourcePatchSha256: null,
                },
          runCell: validFrontierCellResult,
          runConversationProof,
        },
      );

      expect(runConversationProof).toHaveBeenCalledOnce();
      expect(result.exitCode).toBe(1);
      expect(result.summary).toMatchObject({
        status: "blocked",
        blockedReasons: [reason],
        counts: { total: 4, passed: 4, failed: 0 },
        conversationProof: {
          status: "blocked",
          observedStatus: "pass",
          blockedReasons: [reason],
          counts: { total: 2, passed: 2, failed: 0 },
        },
      });
      const conversationSummary = JSON.parse(
        await fs.readFile(
          path.join(repoRoot, "artifacts", "conversation-proof", "summary.json"),
          "utf8",
        ),
      ) as {
        blockedReasons: string[];
        cells: Array<{ id: string }>;
        observedStatus: string;
        status: string;
      };
      expect(conversationSummary).toMatchObject({
        status: "blocked",
        observedStatus: "pass",
        blockedReasons: [reason],
        cells: [{ id: "observed-sidecar-cell" }],
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});
