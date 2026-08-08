import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodeModeMatrixBetaGate,
  buildCodeModeMatrixEvidence,
  classifyMatrixCacheStatus,
  resolveCodeModeMatrixExitCode,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
} from "../../../scripts/code-mode-model-matrix.ts";
import { createValidConversationProofSummaryFixture } from "../../../scripts/lib/code-mode-model-matrix-conversation-proof.test-support.js";
import { validFrontierCellResult } from "./code-mode-model-matrix.test-helpers.js";

const frozenConfig = `{
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
}\n`;

const matrixAuthProfile = async (_params: { profileId: string }) => ({
  credentialEnvName: "OPENAI_API_KEY",
  credentialValue: "sk-matrix-test",
  mode: "api_key" as const,
  present: true,
  provider: "openai",
});

const exact = (value: number) => ({ state: "exact" as const, value });

function result(params: {
  mode: "direct" | "code";
  repetition: number;
  cachedInput: number;
  firstCachedInput?: number;
  effectiveTurns: number;
  tokens: number;
  elapsedMs?: number;
  physicalFetchDispatch?: number;
  wallLatencyMs?: number;
}): CodeModeMatrixCellResult {
  const physicalFetchDispatch = params.physicalFetchDispatch ?? (params.mode === "code" ? 1 : 2);
  const totalToolOperations = params.mode === "code" ? 2 : 1;
  return {
    buildSha256: "build",
    firstLogicalCallCacheStatus: (params.firstCachedInput ?? 0) === 0 ? "cold" : "warm",
    codeModeEngaged: params.mode === "code",
    configSha256: "config",
    elapsedMs: params.elapsedMs ?? 100,
    evidenceClass: "frontier_beta_qualification",
    wallLatencyMs: params.wallLatencyMs ?? params.elapsedMs ?? 100,
    wallLatencyMeasurement: "matrix_monotonic_elapsed",
    expected: "expected",
    failureCategory: null,
    final: "expected",
    fixtureSha256: "fixture",
    gitSha: "git",
    id: `${params.mode}-${String(params.repetition)}`,
    mode: params.mode,
    model: "openai/gpt-5.6",
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
    promptSha256: "prompt",
    repetition: params.repetition,
    sourceDirty: false,
    sourcePatchSha256: null,
    status: "ok",
    task: "read",
    timestamp: "2026-08-06T00:00:00.000Z",
    trace: {
      schemaVersion: 4,
      source: "agent-command-accounting",
      route: {
        provider: "openai",
        model: "gpt-5.6",
        api: "openai-responses",
        runtime: "embedded",
      },
      metrics: {
        effectiveTurns: exact(params.effectiveTurns),
        logicalModelCalls: exact(1),
        providerAttempts: {
          total: exact(1),
          initial: exact(1),
          retries: exact(0),
          authRecoveries: exact(0),
          payloadRecoveries: exact(0),
          transportFallbacks: exact(0),
        },
        physicalFetchDispatch: exact(physicalFetchDispatch),
        outerToolCalls: exact(1),
        codeModeBridgeCalls: exact(params.mode === "code" ? 1 : 0),
        totalToolOperations: exact(totalToolOperations),
        underlyingTotalCalls: exact(physicalFetchDispatch + totalToolOperations),
        tokens: {
          input: exact(params.tokens - 10),
          cachedInput: exact(params.cachedInput),
          firstLogicalCallCachedInput: exact(params.firstCachedInput ?? 0),
          output: exact(10),
          reasoning: exact(0),
          total: exact(params.tokens),
        },
        agentDurationMs: exact(50),
        commandExecutionDurationMs: exact(50),
      },
      audit: { state: "valid" },
    },
  };
}

function passingCells(): CodeModeMatrixCellResult[] {
  return [
    result({
      mode: "direct",
      repetition: 1,
      cachedInput: 0,
      effectiveTurns: 4,
      tokens: 100,
    }),
    result({
      mode: "code",
      repetition: 1,
      cachedInput: 0,
      effectiveTurns: 2,
      tokens: 80,
    }),
    result({
      mode: "code",
      repetition: 2,
      cachedInput: 10,
      effectiveTurns: 2,
      tokens: 80,
    }),
    result({
      mode: "direct",
      repetition: 2,
      cachedInput: 10,
      effectiveTurns: 4,
      tokens: 100,
    }),
  ];
}

describe("Code Mode matrix Beta gate", () => {
  it("records live diagnostic dispatch without admitting it to the Beta gate", () => {
    const cell = result({
      mode: "code",
      repetition: 1,
      cachedInput: 0,
      effectiveTurns: 2,
      tokens: 80,
    });
    cell.evidenceClass = "diagnostic_only";
    const evidence = buildCodeModeMatrixEvidence({
      evidenceClass: "diagnostic_only",
      generatedAt: "2026-08-07T00:00:00.000Z",
      repoRoot: process.cwd(),
      results: [cell],
    });
    expect(evidence.entries[0]).toMatchObject({
      evidenceClass: "diagnostic_only",
      execution: {
        provider: {
          id: "openai",
          live: true,
        },
      },
    });
    expect(evidence.entries[0]?.execution?.provider).not.toHaveProperty("fixture");

    const preDispatch = structuredClone(cell);
    delete preDispatch.trace;
    const preDispatchEvidence = buildCodeModeMatrixEvidence({
      evidenceClass: "diagnostic_only",
      generatedAt: "2026-08-07T00:00:00.000Z",
      repoRoot: process.cwd(),
      results: [preDispatch],
    });
    expect(preDispatchEvidence.entries[0]?.execution?.provider).toMatchObject({
      live: false,
    });
    expect(preDispatchEvidence.entries[0]?.execution?.provider).not.toHaveProperty("fixture");
    const diagnosticCells = passingCells();
    for (const entry of diagnosticCells) {
      entry.evidenceClass = "diagnostic_only";
    }
    expect(buildCodeModeMatrixBetaGate(diagnosticCells)).toMatchObject({
      state: "inconclusive",
      bars: { auditableMatchedTraces: "unknown" },
    });
  });

  it("derives cache state only from exact cached input", () => {
    expect(
      classifyMatrixCacheStatus(
        result({
          mode: "direct",
          repetition: 1,
          cachedInput: 0,
          effectiveTurns: 2,
          tokens: 20,
        }).trace,
      ),
    ).toBe("cold");
    expect(
      classifyMatrixCacheStatus(
        result({
          mode: "code",
          repetition: 1,
          cachedInput: 5,
          firstCachedInput: 5,
          effectiveTurns: 1,
          tokens: 15,
        }).trace,
      ),
    ).toBe("warm");
    const legacy = structuredClone(
      result({
        mode: "direct",
        repetition: 1,
        cachedInput: 0,
        effectiveTurns: 2,
        tokens: 20,
      }).trace,
    ) as unknown as { schemaVersion: number };
    legacy.schemaVersion = 3;
    expect(classifyMatrixCacheStatus(legacy as never)).toBe("unknown");
    const unknown = result({
      mode: "direct",
      repetition: 1,
      cachedInput: 0,
      effectiveTurns: 2,
      tokens: 20,
    }).trace!;
    unknown.metrics.tokens.firstLogicalCallCachedInput = {
      state: "unknown",
      reasons: ["first_logical_call_cached_input_unknown"],
    };
    expect(classifyMatrixCacheStatus(unknown)).toBe("unknown");
    expect(classifyMatrixCacheStatus(undefined)).toBe("unknown");
  });

  it("requires every conjunctive Beta bar and blocks call regressions", () => {
    const cells = passingCells();
    expect(buildCodeModeMatrixBetaGate(cells)).toMatchObject({
      state: "diagnostic_pass",
      bars: {
        accuracyNonRegression: "pass",
        fewerEffectiveTurns: "pass",
        fewerTokens: "pass",
        noRegressionInCallsOrWallLatency: "pass",
        auditableMatchedTraces: "pass",
        coldInitialPerCell: "pass",
      },
      diagnostics: {
        retry_regression: {
          state: "not_observed",
          blocking: false,
          confidence: "lower",
          directRetries: 0,
          codeRetries: 0,
        },
      },
      totals: {
        direct: {
          cachedInputTokens: 10,
          providerAttempts: 2,
          retries: 0,
          authRecoveries: 0,
          payloadRecoveries: 0,
          transportFallbacks: 0,
          additionalProviderAttempts: 0,
          physicalFetchDispatch: 4,
          totalToolOperations: 2,
          underlyingTotalCalls: 6,
          wallLatencyMs: 200,
        },
        code: {
          cachedInputTokens: 10,
          providerAttempts: 2,
          retries: 0,
          authRecoveries: 0,
          payloadRecoveries: 0,
          transportFallbacks: 0,
          additionalProviderAttempts: 0,
          physicalFetchDispatch: 2,
          totalToolOperations: 4,
          underlyingTotalCalls: 6,
          wallLatencyMs: 200,
        },
      },
    });
    const regressed = structuredClone(cells);
    for (const cell of regressed) {
      if (cell.mode === "code" && cell.trace) {
        cell.trace.metrics.physicalFetchDispatch = exact(2);
        cell.trace.metrics.underlyingTotalCalls = exact(4);
      }
    }
    expect(buildCodeModeMatrixBetaGate(regressed)).toMatchObject({
      state: "blocked",
      bars: { noRegressionInCallsOrWallLatency: "fail" },
    });
    const retryRegressed = structuredClone(cells);
    for (const cell of retryRegressed) {
      if (!cell.trace) {
        continue;
      }
      const physicalFetchDispatch = cell.mode === "code" ? 2 : 3;
      cell.trace.metrics.physicalFetchDispatch = exact(physicalFetchDispatch);
      cell.trace.metrics.underlyingTotalCalls = exact(4);
      if (cell.mode === "code") {
        cell.trace.metrics.providerAttempts.total = exact(2);
        cell.trace.metrics.providerAttempts.retries = exact(1);
      }
    }
    expect(buildCodeModeMatrixBetaGate(retryRegressed)).toMatchObject({
      state: "diagnostic_pass",
      diagnostics: {
        retry_regression: {
          state: "observed",
          blocking: false,
          confidence: "lower",
          directRetries: 0,
          codeRetries: 2,
        },
      },
    });
    const codeOnlyPassing = structuredClone(cells);
    for (const cell of codeOnlyPassing) {
      if (cell.mode === "direct") {
        cell.passed = false;
      }
    }
    expect(buildCodeModeMatrixBetaGate(codeOnlyPassing)).toMatchObject({
      state: "diagnostic_pass",
      bars: { accuracyNonRegression: "pass" },
      totals: {
        direct: { passed: 0 },
        code: { passed: 2 },
      },
    });
    const noPassingTasks = structuredClone(cells);
    for (const cell of noPassingTasks) {
      cell.passed = false;
    }
    expect(buildCodeModeMatrixBetaGate(noPassingTasks)).toMatchObject({
      state: "blocked",
      bars: { accuracyNonRegression: "fail" },
    });
    const diagnosticOnly = structuredClone(cells);
    for (const cell of diagnosticOnly) {
      cell.evidenceClass = "diagnostic_only";
    }
    expect(buildCodeModeMatrixBetaGate(diagnosticOnly)).toMatchObject({
      state: "inconclusive",
      bars: {
        accuracyNonRegression: "unknown",
        auditableMatchedTraces: "unknown",
      },
    });
    const warm = structuredClone(cells);
    for (const cell of warm) {
      if (cell.trace) {
        cell.trace.metrics.tokens.firstLogicalCallCachedInput = exact(1);
        cell.firstLogicalCallCacheStatus = "warm";
      }
    }
    expect(buildCodeModeMatrixBetaGate(warm)).toMatchObject({
      state: "blocked",
      bars: { coldInitialPerCell: "fail" },
    });

    const missingWallLatency = structuredClone(cells);
    delete missingWallLatency[1]!.wallLatencyMs;
    expect(buildCodeModeMatrixBetaGate(missingWallLatency)).toMatchObject({
      state: "inconclusive",
      bars: { noRegressionInCallsOrWallLatency: "unknown" },
      totals: { code: { wallLatencyMs: null } },
    });
  });

  it("keeps every non-initial provider-attempt category distinct", () => {
    const cells = passingCells();
    for (const cell of cells) {
      if (!cell.trace) {
        continue;
      }
      const attempts = cell.trace.metrics.providerAttempts;
      attempts.total = exact(2);
      if (cell.mode === "direct" && cell.repetition === 1) {
        attempts.retries = exact(1);
      } else if (cell.mode === "direct") {
        attempts.authRecoveries = exact(1);
      } else if (cell.repetition === 1) {
        attempts.payloadRecoveries = exact(1);
      } else {
        attempts.transportFallbacks = exact(1);
      }
    }

    expect(buildCodeModeMatrixBetaGate(cells)).toMatchObject({
      totals: {
        direct: {
          providerAttempts: 4,
          retries: 1,
          authRecoveries: 1,
          payloadRecoveries: 0,
          transportFallbacks: 0,
          additionalProviderAttempts: 2,
        },
        code: {
          providerAttempts: 4,
          retries: 0,
          authRecoveries: 0,
          payloadRecoveries: 1,
          transportFallbacks: 1,
          additionalProviderAttempts: 2,
        },
      },
    });
  });

  it("returns nonzero unless every Beta and optional behavior gate passes", () => {
    const passing = {
      allowFailures: true,
      betaGateState: "diagnostic_pass" as const,
      conversationProofRequired: false,
      failed: 0,
      frontierEvidenceValid: true,
    };
    expect(resolveCodeModeMatrixExitCode(passing)).toBe(0);
    expect(resolveCodeModeMatrixExitCode({ ...passing, betaGateState: "blocked" })).toBe(1);
    expect(resolveCodeModeMatrixExitCode({ ...passing, betaGateState: "inconclusive" })).toBe(1);
    expect(
      resolveCodeModeMatrixExitCode({
        ...passing,
        conversationProofRequired: true,
        conversationProofAttested: true,
        conversationProofStatus: "pass",
      }),
    ).toBe(0);
    expect(
      resolveCodeModeMatrixExitCode({
        ...passing,
        conversationProofRequired: true,
        conversationProofStatus: "fail",
      }),
    ).toBe(1);
    expect(
      resolveCodeModeMatrixExitCode({
        ...passing,
        conversationProofRequired: true,
      }),
    ).toBe(1);
  });
});

describe("Code Mode matrix conversation-proof schedule", () => {
  it("classifies a passing paired proof as ready only for the frozen benchmark", async () => {
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-code-mode-proof-pass-test-"),
    );
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig, "utf8");
      const matrix = await runCodeModeModelMatrix(
        {
          allowFailures: false,
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
          timeoutSeconds: 600,
        },
        {
          buildCliArtifacts: async () => {},
          nowMs: (() => {
            let value = 0;
            return () => (value += 100);
          })(),
          readAuthProfile: matrixAuthProfile,
          readBuildSha256: async () => "b".repeat(64),
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
          runCell: validFrontierCellResult,
          runConversationProof: async (params) =>
            createValidConversationProofSummaryFixture({
              buildSha256: params.buildSha256,
              configSha256: params.configSha256,
              executionPolicy: params.executionPolicy,
              gitSha: params.gitSha,
              model: params.model,
            }),
        },
      );

      expect(matrix.exitCode, JSON.stringify(matrix.summary)).toBe(0);
      expect(matrix.summary).toMatchObject({
        status: "complete",
        evidenceClass: "frontier_beta_qualification",
        qualification: {
          state: "ready_for_frozen_benchmark",
          betaRecommendation: "not_eligible",
          reason: "requires_frozen_representative_benchmark",
        },
        counts: { total: 4, passed: 4, failed: 0 },
        conversationProof: { status: "pass", attested: true },
      });
      const evidence = JSON.parse(
        await fs.readFile(path.join(repoRoot, "artifacts", "qa-evidence.json"), "utf8"),
      ) as {
        entries: Array<{
          evidenceClass?: string;
          test: { id: string };
          result: { status: string };
        }>;
      };
      expect(evidence.entries).toHaveLength(5);
      expect(
        evidence.entries.every((entry) => entry.evidenceClass === "frontier_beta_qualification"),
      ).toBe(true);
      expect(evidence.entries.at(-1)).toMatchObject({
        execution: { packageSource: { sha: "abc123" } },
        test: { id: "conversation-proof" },
        result: { status: "pass" },
      });

      const invalid = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          config: configPath,
          conversationProof: true,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "artifacts-invalid-proof",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          buildCliArtifacts: async () => {},
          nowMs: (() => {
            let value = 0;
            return () => (value += 100);
          })(),
          readAuthProfile: matrixAuthProfile,
          readBuildSha256: async () => "b".repeat(64),
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
          runCell: validFrontierCellResult,
          runConversationProof: async () => ({
            status: "pass" as const,
            counts: { total: 2, passed: 2, failed: 0 },
          }),
        },
      );
      expect(invalid.exitCode).toBe(1);
      expect(invalid.summary).toMatchObject({
        status: "fail",
        qualification: {
          state: "not_eligible",
          betaRecommendation: "not_eligible",
          reason: "conversation_proof_not_completed",
        },
        conversationProof: {
          status: "fail",
          attested: false,
          observedStatus: "pass",
          failureCode: "conversation_proof_attestation_invalid",
        },
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "failed wall-latency bar",
      expectedBlockedReason: undefined,
      expectedBlockingBars: true,
      expectedStatus: "fail",
      expectedReason: "beta_gate_blocked",
      mutate: (_cellResult: Awaited<ReturnType<typeof validFrontierCellResult>>) => {},
    },
    {
      name: "unknown token bar",
      expectedBlockedReason: undefined,
      expectedBlockingBars: true,
      expectedStatus: "blocked",
      expectedReason: "beta_gate_inconclusive",
      mutate: (cellResult: Awaited<ReturnType<typeof validFrontierCellResult>>) => {
        if (cellResult.mode === "code" && cellResult.trace) {
          cellResult.trace.metrics.tokens.total = {
            state: "unavailable",
            reasons: ["test_metric_unavailable"],
          };
        }
      },
    },
    {
      name: "unknown retry receipt audit",
      expectedBlockedReason: "frontier_trace_transport_mismatch",
      expectedBlockingBars: false,
      expectedStatus: "blocked",
      expectedReason: "abba_incomplete",
      mutate: (cellResult: Awaited<ReturnType<typeof validFrontierCellResult>>) => {
        if (cellResult.mode === "code" && cellResult.trace) {
          cellResult.trace.metrics.providerAttempts.retries = {
            state: "unavailable",
            reasons: ["test_retry_metric_unavailable"],
          };
        }
      },
    },
  ])(
    "never qualifies an attested proof when matched evidence has a $name",
    async ({
      expectedBlockedReason,
      expectedBlockingBars,
      expectedReason,
      expectedStatus,
      mutate,
    }) => {
      const repoRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-code-mode-beta-block-test-"),
      );
      try {
        const configPath = path.join(repoRoot, "matrix.json5");
        await fs.writeFile(configPath, frozenConfig, "utf8");
        const runConversationProof = vi.fn(async (params) =>
          createValidConversationProofSummaryFixture({
            buildSha256: params.buildSha256,
            configSha256: params.configSha256,
            executionPolicy: params.executionPolicy,
            gitSha: params.gitSha,
            model: params.model,
          }),
        );
        const matrix = await runCodeModeModelMatrix(
          {
            allowFailures: false,
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
            timeoutSeconds: 600,
          },
          {
            buildCliArtifacts: async () => {},
            nowMs:
              expectedReason === "beta_gate_blocked"
                ? (() => {
                    const deltas = [100, 200, 200, 100];
                    let call = 0;
                    let value = 0;
                    return () => {
                      if (call % 2 === 1) {
                        value += deltas[Math.floor(call / 2)] ?? 100;
                      }
                      call += 1;
                      return value;
                    };
                  })()
                : (() => {
                    let value = 0;
                    return () => (value += 100);
                  })(),
            readAuthProfile: matrixAuthProfile,
            readBuildSha256: async () => "b".repeat(64),
            readSourceIdentity: async () => ({
              gitSha: "abc123",
              sourceDirty: false,
              sourcePatchSha256: null,
            }),
            runCell: async (params) => {
              const cellResult = await validFrontierCellResult(params);
              mutate(cellResult);
              return cellResult;
            },
            runConversationProof,
          },
        );

        expect(matrix.exitCode).toBe(1);
        expect(matrix.summary).toMatchObject({
          status: expectedStatus,
          qualification: {
            state: "not_eligible",
            reason: expectedReason,
            ...(expectedBlockingBars ? { blockingBars: expect.any(Array) } : {}),
          },
          ...(expectedBlockedReason ? { blockedReasons: [expectedBlockedReason] } : {}),
        });
        expect(runConversationProof).not.toHaveBeenCalled();
      } finally {
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );

  it("dry-runs exactly seven planned executions without providers", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-dry-run-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig, "utf8");
      const runCell = vi.fn();
      const matrix = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          config: configPath,
          conversationProof: true,
          dryRun: true,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          readAuthProfile: matrixAuthProfile,
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
          runCell,
        },
      );

      expect(matrix.exitCode).toBe(0);
      expect(runCell).not.toHaveBeenCalled();
      expect(matrix.summary).toMatchObject({
        status: "dry-run",
        evidenceClass: "frontier_beta_qualification",
        qualification: {
          state: "not_eligible",
          betaRecommendation: "not_eligible",
          reason: "conversation_proof_not_completed",
        },
        cellsExecuted: 0,
        totalPlanned: 7,
        plannedExecutions: { matrix: 4, conversationProof: 3, total: 7 },
      });
      const manifest = JSON.parse(
        await fs.readFile(path.join(repoRoot, "artifacts", "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        schemaVersion: 4,
        evidenceClass: "frontier_beta_qualification",
        plannedExecutions: { matrix: 4, conversationProof: 3, total: 7 },
      });
      expect(JSON.stringify(manifest)).not.toContain('"defaultAgentId":"main"');
      expect(manifest.executionPolicy).toMatchObject({
        defaultAgentIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(JSON.stringify(matrix.summary)).not.toContain('"defaultAgentId":"main"');
      const summary = matrix.summary as { executionPolicy?: unknown };
      expect(summary.executionPolicy).toMatchObject({
        defaultAgentIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("blocks programmatic frontier qualification with multiple models", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-models-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig, "utf8");
      const matrix = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          config: configPath,
          conversationProof: true,
          dryRun: true,
          keepState: false,
          models: ["openai/gpt-5.6", "openai/gpt-unsupported"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          readAuthProfile: matrixAuthProfile,
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
        },
      );

      expect(matrix.exitCode).toBe(1);
      expect(matrix.summary).toMatchObject({
        status: "blocked",
        blockedReasons: ["frontier_model_cardinality_invalid"],
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("blocks conversation proof outside the exact paired schedule", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-schedule-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig, "utf8");
      const matrix = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          config: configPath,
          conversationProof: true,
          dryRun: true,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["read", "dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          readAuthProfile: matrixAuthProfile,
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
        },
      );

      expect(matrix.exitCode).toBe(1);
      expect(matrix.summary).toMatchObject({
        status: "blocked",
        blockedReasons: ["conversation_proof_schedule_invalid"],
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});
