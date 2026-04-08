import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaCharacterEval, type QaCharacterEvalParams } from "./character-eval.js";
import type { QaSuiteResult } from "./suite.js";

type CharacterRunSuiteParams = Parameters<NonNullable<QaCharacterEvalParams["runSuite"]>>[0];
type CharacterRunJudgeParams = Parameters<NonNullable<QaCharacterEvalParams["runJudge"]>>[0];

function makeSuiteResult(params: { outputDir: string; model: string; transcript: string }) {
  return {
    outputDir: params.outputDir,
    reportPath: path.join(params.outputDir, "qa-suite-report.md"),
    summaryPath: path.join(params.outputDir, "qa-suite-summary.json"),
    report: "# report",
    watchUrl: "http://127.0.0.1:43124",
    scenarios: [
      {
        name: "Character vibes",
        status: "pass",
        steps: [
          {
            name: `transcript for ${params.model}`,
            status: "pass",
            details: params.transcript,
          },
        ],
      },
    ],
  } satisfies QaSuiteResult;
}

describe("runQaCharacterEval", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-character-eval-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("runs each requested model and writes a judged report with transcripts", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      const model = params.primaryModel;
      const transcript = `USER Alice: prompt for ${model}\n\nASSISTANT openclaw: reply from ${model}`;
      return makeSuiteResult({ outputDir: params.outputDir, model, transcript });
    });
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) =>
      JSON.stringify({
        rankings: [
          {
            model: "openai/gpt-5.4",
            rank: 1,
            score: 9.1,
            summary: "Most natural.",
            strengths: ["vivid"],
            weaknesses: ["none"],
          },
          {
            model: "codex-cli/test-model",
            rank: 2,
            score: 7,
            summary: "Readable but flatter.",
            strengths: ["coherent"],
            weaknesses: ["less funny"],
          },
        ],
      }),
    );

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "codex-cli/test-model", "openai/gpt-5.4"],
      scenarioId: "character-vibes-gollum",
      candidateFastMode: true,
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(runSuite).toHaveBeenCalledTimes(2);
    expect(runSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.4",
        alternateModel: "openai/gpt-5.4",
        fastMode: true,
        scenarioIds: ["character-vibes-gollum"],
      }),
    );
    expect(runJudge).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeModel: "openai/gpt-5.4",
        judgeThinkingDefault: "xhigh",
        judgeFastMode: true,
      }),
    );
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]?.rankings.map((ranking) => ranking.model)).toEqual([
      "openai/gpt-5.4",
      "codex-cli/test-model",
    ]);

    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("Execution: local QA gateway child processes, not Docker");
    expect(report).toContain("Judges: openai/gpt-5.4");
    expect(report).toContain("## Judge Rankings");
    expect(report).toContain("### openai/gpt-5.4");
    expect(report).toContain("reply from openai/gpt-5.4");
    expect(report).toContain("reply from codex-cli/test-model");
    expect(report).toContain("Judge thinking: xhigh");
    expect(report).toContain("Fast mode: on");
    expect(report).toContain("Duration ms:");
    expect(report).not.toContain("Judge Raw Reply");
  });

  it("defaults to the character eval model panel when no models are provided", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript: `USER Alice: hi\n\nASSISTANT openclaw: reply from ${params.primaryModel}`,
      }),
    );
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) =>
      JSON.stringify({
        rankings: [
          { model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" },
          { model: "openai/gpt-5.2", rank: 2, score: 7.5, summary: "ok" },
          { model: "anthropic/claude-opus-4-6", rank: 3, score: 7, summary: "ok" },
          { model: "anthropic/claude-sonnet-4-6", rank: 4, score: 6.8, summary: "ok" },
          { model: "minimax/MiniMax-M2.7", rank: 5, score: 6.5, summary: "ok" },
          { model: "zai/glm-5.1", rank: 6, score: 6.3, summary: "ok" },
          { model: "moonshot/kimi-k2.5", rank: 7, score: 6.2, summary: "ok" },
          { model: "qwen/qwen3.6-plus", rank: 8, score: 6.1, summary: "ok" },
          { model: "xiaomi/mimo-v2-pro", rank: 9, score: 6, summary: "ok" },
          { model: "google/gemini-3.1-pro-preview", rank: 10, score: 5.9, summary: "ok" },
        ],
      }),
    );

    await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: [],
      runSuite,
      runJudge,
    });

    expect(runSuite).toHaveBeenCalledTimes(10);
    expect(runSuite.mock.calls.map(([params]) => params.primaryModel)).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.2",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "minimax/MiniMax-M2.7",
      "zai/glm-5.1",
      "moonshot/kimi-k2.5",
      "qwen/qwen3.6-plus",
      "xiaomi/mimo-v2-pro",
      "google/gemini-3.1-pro-preview",
    ]);
    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "xhigh",
      "xhigh",
      "high",
      "high",
      "high",
      "high",
      "high",
      "high",
      "high",
      "high",
    ]);
    expect(runSuite.mock.calls.map(([params]) => params.fastMode)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(runJudge).toHaveBeenCalledTimes(2);
    expect(runJudge.mock.calls.map(([params]) => params.judgeModel)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-opus-4-6",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeThinkingDefault)).toEqual([
      "xhigh",
      "high",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeFastMode)).toEqual([true, false]);
  });

  it("lets explicit candidate thinking override the default panel", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript: `USER Alice: hi\n\nASSISTANT openclaw: reply from ${params.primaryModel}`,
      }),
    );
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) =>
      JSON.stringify({
        rankings: [
          { model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" },
          { model: "moonshot/kimi-k2.5", rank: 2, score: 7, summary: "ok" },
        ],
      }),
    );

    await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "moonshot/kimi-k2.5"],
      candidateThinkingDefault: "medium",
      candidateThinkingByModel: { "moonshot/kimi-k2.5": "high" },
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "medium",
      "high",
    ]);
  });

  it("lets model-specific options override candidate and judge defaults", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript: `USER Alice: hi\n\nASSISTANT openclaw: reply from ${params.primaryModel}`,
      }),
    );
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) =>
      JSON.stringify({
        rankings: [{ model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" }],
      }),
    );

    await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "moonshot/kimi-k2.5"],
      candidateFastMode: true,
      candidateThinkingDefault: "medium",
      candidateModelOptions: {
        "openai/gpt-5.4": { thinkingDefault: "xhigh", fastMode: false },
      },
      judgeModels: ["openai/gpt-5.4", "anthropic/claude-opus-4-6"],
      judgeThinkingDefault: "medium",
      judgeModelOptions: {
        "openai/gpt-5.4": { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-6": { thinkingDefault: "high" },
      },
      runSuite,
      runJudge,
    });

    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "xhigh",
      "medium",
    ]);
    expect(runSuite.mock.calls.map(([params]) => params.fastMode)).toEqual([false, true]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeThinkingDefault)).toEqual([
      "xhigh",
      "high",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeFastMode)).toEqual([true, false]);
  });

  it("keeps failed model runs in the report for grader context", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      if (params.primaryModel === "codex-cli/test-model") {
        throw new Error("backend unavailable");
      }
      return makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript: "USER Alice: hi\n\nASSISTANT openclaw: hello",
      });
    });
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) =>
      JSON.stringify({
        rankings: [{ model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" }],
      }),
    );

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "codex-cli/test-model"],
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(result.runs.map((run) => run.status)).toEqual(["pass", "fail"]);
    expect(result.runs[1]?.error).toContain("backend unavailable");
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("backend unavailable");
  });
});
