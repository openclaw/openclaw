import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
  type CodeModeMatrixOptions,
} from "../../../scripts/code-mode-model-matrix.ts";
import type { CodeModeConversationProofPolicy } from "../../../scripts/lib/code-mode-model-matrix-conversation-proof.js";
import { createValidConversationProofSummaryFixture } from "../../../scripts/lib/code-mode-model-matrix-conversation-proof.test-support.js";
import {
  deriveTestPromptCacheKey,
  frozenFrontierConfig,
  matrixFrontierAuthProfile,
  validFrontierCellResult,
} from "./code-mode-model-matrix.test-helpers.js";

function options(repoRoot: string): CodeModeMatrixOptions {
  return {
    allowFailures: true,
    conversationProof: true,
    config: path.join(repoRoot, "matrix.json5"),
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
  };
}

function dependencies() {
  let clock = 0;
  return {
    buildCliArtifacts: async () => {},
    nowMs: () => {
      clock += 10;
      return clock;
    },
    readBuildSha256: async () => "b".repeat(64),
    readSourceIdentity: async () => ({
      gitSha: "abc123",
      sourceDirty: false,
      sourcePatchSha256: null,
    }),
    readAuthProfile: matrixFrontierAuthProfile,
    runConversationProof: async (params: {
      buildSha256: string;
      configSha256: string;
      executionPolicy: CodeModeConversationProofPolicy;
      gitSha: string;
      model: string;
    }) =>
      createValidConversationProofSummaryFixture({
        buildSha256: params.buildSha256,
        configSha256: params.configSha256,
        executionPolicy: params.executionPolicy,
        gitSha: params.gitSha,
        model: params.model,
      }),
  };
}

describe("Code Mode matrix zero-provider frontier proof", () => {
  it("continues all ABBA cells when a task fails with valid v4 evidence", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-task-fail-test-"));
    try {
      await fs.writeFile(path.join(repoRoot, "matrix.json5"), frozenFrontierConfig, "utf8");
      let calls = 0;
      const result = await runCodeModeModelMatrix(options(repoRoot), {
        ...dependencies(),
        runCell: async (params) => {
          calls += 1;
          return validFrontierCellResult(params, { passed: calls !== 1 });
        },
      });

      expect(calls).toBe(4);
      expect(result.summary).toMatchObject({
        counts: { total: 4, passed: 3, failed: 1 },
        frontierEvidenceAudit: { valid: true, reasons: [] },
      });
      const lines = (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(4);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        failureCategory: "answer_mismatch",
        trace: { schemaVersion: 4, audit: { state: "valid" } },
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it.each(["provider_auth", "provider_billing", "provider_model_access"] as const)(
    "persists one %s result and blocks the remaining cells",
    async (failureCategory) => {
      const repoRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-code-mode-access-fail-test-"),
      );
      try {
        await fs.writeFile(path.join(repoRoot, "matrix.json5"), frozenFrontierConfig, "utf8");
        let calls = 0;
        const result = await runCodeModeModelMatrix(options(repoRoot), {
          ...dependencies(),
          runCell: async (params) => {
            calls += 1;
            const cell = await validFrontierCellResult(params);
            cell.failureCategory = failureCategory;
            cell.passed = false;
            cell.status = "error";
            cell.error = { kind: failureCategory, message: failureCategory };
            return cell;
          },
        });

        expect(calls).toBe(1);
        expect(result.summary).toMatchObject({
          status: "blocked",
          blockedReasons: [failureCategory],
          counts: { total: 1, passed: 0, failed: 1 },
        });
        const lines = (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8"))
          .trim()
          .split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
          failureCategory,
          trace: { schemaVersion: 4, audit: { state: "valid" } },
        });
        const evidence = JSON.parse(
          await fs.readFile(path.join(repoRoot, "artifacts", "qa-evidence.json"), "utf8"),
        ) as {
          entries: Array<{ result: { failure?: { class?: string }; status: string } }>;
        };
        expect(evidence.entries).toHaveLength(2);
        expect(evidence.entries[0]?.result).toMatchObject({
          status: "blocked",
          failure: { class: failureCategory },
        });
      } finally {
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );

  it("measures wall latency across admission, execution cleanup, and post-run audit", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-wall-test-"));
    try {
      await fs.writeFile(path.join(repoRoot, "matrix.json5"), frozenFrontierConfig, "utf8");
      let clock = 0;
      const result = await runCodeModeModelMatrix(options(repoRoot), {
        ...dependencies(),
        nowMs: () => {
          clock += 25;
          return clock;
        },
        runCell: async (params) => {
          const cell = await validFrontierCellResult(params);
          cell.elapsedMs = 1;
          delete cell.wallLatencyMs;
          return cell;
        },
      });

      expect(result.summary).toMatchObject({
        betaGate: {
          bars: { noRegressionInCallsOrWallLatency: "pass" },
          totals: {
            direct: { wallLatencyMs: 50 },
            code: { wallLatencyMs: 50 },
          },
        },
      });
      const cells = (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CodeModeMatrixCellResult);
      expect(cells.map((cell) => cell.wallLatencyMs)).toEqual([25, 25, 25, 25]);
      expect(cells.map((cell) => cell.elapsedMs)).toEqual([1, 1, 1, 1]);
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("produces four isolated cold-cache cells without leaking cache affinity", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-isolation-test-"));
    try {
      await fs.writeFile(path.join(repoRoot, "matrix.json5"), frozenFrontierConfig, "utf8");
      const rawNonces: string[] = [];
      const rawCacheKeys: string[] = [];
      const result = await runCodeModeModelMatrix(
        { ...options(repoRoot), allowFailures: false },
        {
          ...dependencies(),
          runCell: async (params) => {
            const policy = JSON.parse(
              await fs.readFile(params.frontierEvidencePolicy!.path, "utf8"),
            ) as { contentDigestKey: string };
            const runNonce = params.frontierEvidenceRunNonce;
            if (!runNonce) {
              throw new Error("frontier evidence run nonce missing");
            }
            rawNonces.push(runNonce);
            rawCacheKeys.push(deriveTestPromptCacheKey(policy.contentDigestKey, runNonce));
            return validFrontierCellResult(params);
          },
        },
      );

      expect(result.exitCode, JSON.stringify(result.summary)).toBe(0);
      expect(result.summary).toMatchObject({
        evidenceClass: "frontier_beta_qualification",
        qualification: {
          state: "ready_for_frozen_benchmark",
          betaRecommendation: "not_eligible",
          reason: "requires_frozen_representative_benchmark",
        },
        counts: { total: 4, passed: 4, failed: 0 },
        frontierEvidenceAudit: { valid: true, reasons: [] },
        betaGate: {
          state: "diagnostic_pass",
          bars: {
            auditableMatchedTraces: "pass",
            coldInitialPerCell: "pass",
          },
        },
      });
      const results = (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CodeModeMatrixCellResult);
      expect(new Set(rawNonces).size).toBe(4);
      expect(new Set(rawCacheKeys).size).toBe(4);
      expect(
        new Set(results.map((cell) => cell.frontierEvidence?.[0]?.promptCacheKeyDigest)).size,
      ).toBe(4);
      expect(new Set(results.map((cell) => cell.workspaceIdentitySha256)).size).toBe(4);
      expect(new Set(results.map((cell) => cell.workspaceSeedSha256)).size).toBe(1);
      expect(
        results.every(
          (cell) =>
            cell.evidenceClass === "frontier_beta_qualification" &&
            cell.firstLogicalCallCacheStatus === "cold" &&
            cell.trace?.metrics.tokens.firstLogicalCallCachedInput.state === "exact" &&
            cell.trace.metrics.tokens.firstLogicalCallCachedInput.value === 0,
        ),
      ).toBe(true);

      const artifacts = await Promise.all(
        ["manifest.json", "results.jsonl", "summary.json", "qa-evidence.json"].map((file) =>
          fs.readFile(path.join(repoRoot, "artifacts", file), "utf8"),
        ),
      );
      const serializedArtifacts = artifacts.join("\n");
      for (const secret of [...rawNonces, ...rawCacheKeys, repoRoot]) {
        expect(serializedArtifacts).not.toContain(secret);
      }
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "missing trace",
      (cell: CodeModeMatrixCellResult) => {
        delete cell.trace;
      },
    ],
    [
      "inconclusive trace",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.trace) {
          cell.trace.audit = { state: "inconclusive", reasons: ["synthetic_drift"] };
        }
      },
    ],
    [
      "missing receipt",
      (cell: CodeModeMatrixCellResult) => {
        delete cell.frontierEvidence;
      },
    ],
    [
      "invalid receipt",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.frontierEvidence?.[0]) {
          cell.frontierEvidence[0].valid = false;
        }
      },
    ],
    [
      "route mismatch",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.trace?.route) {
          cell.trace.route.model = "gpt-5.4-drift";
        }
      },
    ],
    [
      "cache digest mismatch",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.frontierEvidence?.[0]) {
          cell.frontierEvidence[0].promptCacheKeyDigest = "0".repeat(64);
        }
      },
    ],
    [
      "policy sha mismatch",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.frontierEvidence?.[0]) {
          cell.frontierEvidence[0].policySha256 = "0".repeat(64);
        }
      },
    ],
    [
      "auth binding mismatch",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.frontierEvidence?.[0]) {
          cell.frontierEvidence[0].authBindingId = "0".repeat(32);
        }
      },
    ],
    [
      "credential state mismatch",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.frontierEvidence?.[0]) {
          cell.frontierEvidence[0].credentialState = "not_frozen" as "frozen_in_memory";
        }
      },
    ],
    [
      "non-contiguous raw receipt",
      (cell: CodeModeMatrixCellResult) => {
        const request = cell.frontierEvidence?.[0]?.callSequences[0]?.requests[0];
        if (request) {
          request.requestOrdinal = 2;
        }
      },
    ],
    [
      "sanitized receipt mismatch",
      (cell: CodeModeMatrixCellResult) => {
        const receipt = cell.trace?.frontierEvidence;
        if (receipt) {
          receipt.physicalFetchDispatch += 1;
        }
      },
    ],
    [
      "physical dispatch metric mismatch",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.trace) {
          cell.trace.metrics.physicalFetchDispatch = { state: "exact", value: 99 };
        }
      },
    ],
    [
      "underlying total mismatch",
      (cell: CodeModeMatrixCellResult) => {
        if (cell.trace) {
          cell.trace.metrics.underlyingTotalCalls = { state: "exact", value: 99 };
        }
      },
    ],
  ])("stops after one cell on %s", async (_name, mutate) => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-drift-test-"));
    try {
      await fs.writeFile(path.join(repoRoot, "matrix.json5"), frozenFrontierConfig, "utf8");
      let calls = 0;
      const result = await runCodeModeModelMatrix(options(repoRoot), {
        ...dependencies(),
        runCell: async (params) => {
          calls += 1;
          const cell = await validFrontierCellResult(params);
          mutate(cell);
          return cell;
        },
      });

      expect(calls).toBe(1);
      expect(result.summary).toMatchObject({
        counts: { total: 1, passed: 0, failed: 1 },
      });
      const recorded = JSON.parse(
        (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8")).trim(),
      ) as CodeModeMatrixCellResult;
      expect(recorded.failureCategory).toBe("proof_drift");
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});
