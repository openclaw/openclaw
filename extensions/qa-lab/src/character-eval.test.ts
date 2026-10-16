import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaCharacterEval } from "./character-eval.js";
import { makeQaSuiteTestScenario, recordQaSuiteTestResults } from "./suite-test-helpers.js";
import type { QaSuiteResult } from "./suite.js";

type QaCharacterEvalParams = Parameters<typeof runQaCharacterEval>[0];
type QaCharacterEvalJudgment = Awaited<
  ReturnType<typeof runQaCharacterEval>
>["judgments"][number]["rankings"][number];
type CharacterRunSuiteParams = Parameters<NonNullable<QaCharacterEvalParams["runSuite"]>>[0];
type CharacterRunJudgeParams = Parameters<NonNullable<QaCharacterEvalParams["runJudge"]>>[0];
type TestJudgeRanking = Pick<QaCharacterEvalJudgment, "model" | "rank" | "score" | "summary"> &
  Partial<Pick<QaCharacterEvalJudgment, "strengths" | "weaknesses">>;

function makeJudgeReply(rankings: TestJudgeRanking[]) {
  return JSON.stringify({ rankings });
}

const primaryModel = "openai/gpt-5.6-luna";
const kimi = "moonshot/kimi-k2.5";
function makeRanking(model: string, rank = 1, score = 8, summary = "ok"): TestJudgeRanking {
  return { model, rank, score, summary };
}

function makeRunJudge(rankings = [makeRanking(primaryModel)]) {
  return vi.fn(async (_params: CharacterRunJudgeParams) => makeJudgeReply(rankings));
}

function defaultModelTranscript(model: string) {
  return `USER Alice: hi\n\nASSISTANT openclaw: reply from ${model}`;
}

function makeRunSuite(
  transcriptForModel: (model: string) => string = defaultModelTranscript,
  overrides: SuiteOverrides = {},
) {
  return vi.fn(async (params: CharacterRunSuiteParams) =>
    makeSuiteResult(params, { transcript: transcriptForModel(params.primaryModel), ...overrides }),
  );
}

function createConcurrencyGate(expectedActive: number) {
  let active = 0;
  let maxActive = 0;
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  return {
    get maxActive() {
      return maxActive;
    },
    async run<T>(work: () => T | Promise<T>): Promise<T> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active >= expectedActive) {
        started.resolve();
      }
      await released.promise;
      try {
        return await work();
      } finally {
        active -= 1;
      }
    },
    waitForExpectedActive: () => started.promise,
    releaseStartedTasks: () => released.resolve(),
  };
}

type SuiteOverrides = {
  transcript?: string;
  summaryStatus?: "pass" | "fail";
  runStatus?: "running" | "completed";
};

async function makeSuiteResult(params: CharacterRunSuiteParams, overrides: SuiteOverrides = {}) {
  const summaryStatus = overrides.summaryStatus ?? "pass";
  const summaryFailedCount = summaryStatus === "fail" ? 1 : 0;
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  await fs.mkdir(params.outputDir, { recursive: true });
  const summary = {
    run: { status: overrides.runStatus ?? "completed" },
    counts: { total: 1, passed: summaryFailedCount > 0 ? 0 : 1, failed: summaryFailedCount },
    scenarios: [{ name: "Character vibes", status: summaryStatus, steps: [] }],
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    outputDir: params.outputDir,
    evidencePath: path.join(params.outputDir, "qa-evidence.json"),
    reportPath: path.join(params.outputDir, "qa-suite-report.md"),
    summaryPath,
    report: "# report",
    watchUrl: "http://127.0.0.1:43124",
    startedScenarioIds: ["character-vibes"],
    ...recordQaSuiteTestResults(
      undefined,
      [makeQaSuiteTestScenario("character-vibes")],
      [
        {
          name: "Character vibes",
          status: "pass",
          steps: [
            {
              name: `transcript for ${params.primaryModel}`,
              status: "pass",
              details: overrides.transcript ?? defaultModelTranscript(params.primaryModel),
            },
          ],
        },
      ],
    ),
  } satisfies QaSuiteResult;
}

function expectFirstRunFailure(
  result: Awaited<ReturnType<typeof runQaCharacterEval>>,
  expected: { model: string; error: string },
) {
  expect(result.runs[0]).toMatchObject({ ...expected, status: "fail" });
}

describe("runQaCharacterEval", () => {
  let tempRoot: string;

  function runEval(params: Partial<QaCharacterEvalParams>) {
    return runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: [primaryModel],
      judgeModels: [primaryModel],
      runSuite: makeRunSuite(),
      runJudge: makeRunJudge(
        (params.models ?? [primaryModel]).map((ref, index) =>
          makeRanking(ref, index + 1, 8 - index),
        ),
      ),
      ...params,
    });
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-character-eval-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("runs each requested model and writes a judged report with transcripts", async () => {
    const runSuite = makeRunSuite(
      (model) => `USER Alice: prompt for ${model}\n\nASSISTANT openclaw: reply from ${model}`,
    );
    const runJudge = makeRunJudge([
      {
        ...makeRanking(primaryModel, 1, 9.1, "Most natural."),
        strengths: ["vivid"],
        weaknesses: ["none"],
      },
      {
        ...makeRanking("codex-cli/test-model", 2, 7, "Readable but flatter."),
        strengths: ["coherent"],
        weaknesses: ["less funny"],
      },
    ]);

    const result = await runEval({
      models: [primaryModel, "codex-cli/test-model", primaryModel],
      scenarioId: "character-vibes-gollum",
      candidateFastMode: true,
      runSuite,
      runJudge,
    });

    expect(runSuite).toHaveBeenCalledTimes(2);
    expect(runSuite.mock.calls[0]?.[0]).toMatchObject({
      providerMode: "live-frontier",
      primaryModel,
      alternateModel: primaryModel,
      fastMode: true,
      scenarioIds: ["character-vibes-gollum"],
    });
    expect(runJudge.mock.calls[0]?.[0]).toMatchObject({
      judgeModel: primaryModel,
      judgeThinkingDefault: "xhigh",
      judgeFastMode: true,
      timeoutMs: 300_000,
    });
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]?.rankings.map((ranking) => ranking.model)).toEqual([
      "openai/gpt-5.6-luna",
      "codex-cli/test-model",
    ]);

    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("Execution: local QA gateway child processes, not Docker");
    expect(report).toContain("Judges: openai/gpt-5.6-luna");
    expect(report).toContain("Judge model labels: visible");
    expect(report).toContain("## Judge Rankings");
    expect(report).toContain("### openai/gpt-5.6-luna");
    expect(report).toContain("reply from openai/gpt-5.6-luna");
    expect(report).toContain("reply from codex-cli/test-model");
    expect(report).toContain("Judge thinking: xhigh");
    expect(report).toContain("- Timeout: 5m");
    expect(report).toContain("Fast mode: on");
    expect(report).toContain("Duration:");
    expect(report).not.toContain("Duration ms:");
    expect(report).not.toContain("Judge Raw Reply");
  });

  it("isolates artifacts for model refs with colliding readable slugs", async () => {
    const firstModel = "ollama/qwen3.5:9b";
    const secondModel = "ollama/qwen3.5/9b";
    const models = [firstModel, secondModel];
    const firstRunWritten = Promise.withResolvers<void>();
    const secondRunWritten = Promise.withResolvers<void>();
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      const markerPath = path.join(params.outputDir, "model-marker.txt");
      await fs.mkdir(params.outputDir, { recursive: true });
      if (params.primaryModel === secondModel) {
        await firstRunWritten.promise;
      }
      await fs.writeFile(markerPath, `${params.primaryModel}\n`, "utf8");
      const result = await makeSuiteResult(params);
      if (params.primaryModel === firstModel) {
        firstRunWritten.resolve();
        await secondRunWritten.promise;
      } else {
        secondRunWritten.resolve();
      }
      return result;
    });

    const result = await runEval({
      models,
      candidateConcurrency: 2,
      runSuite,
    });

    expect(runSuite).toHaveBeenCalledTimes(2);
    expect.soft(new Set(result.runs.map((run) => run.outputDir)).size).toBe(models.length);
    const summaryPaths = result.runs.flatMap((run) =>
      "summaryPath" in run ? [run.summaryPath] : [],
    );
    expect.soft(new Set(summaryPaths).size).toBe(models.length);
    const markers = await Promise.all(
      result.runs.map((run) => fs.readFile(path.join(run.outputDir, "model-marker.txt"), "utf8")),
    );
    expect.soft(markers).toEqual(models.map((model) => `${model}\n`));
  });

  it("creates a unique default output directory under repo artifacts", async () => {
    const result = await runEval({ outputDir: undefined });

    expect(path.dirname(result.outputDir)).toBe(path.join(tempRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(result.outputDir)).toMatch(/^character-eval-[a-z0-9]+-[a-f0-9]{8}$/u);
    await expect(fs.stat(result.reportPath).then((stats) => stats.isFile())).resolves.toBe(true);
  });

  it("can hide candidate model refs from judge prompts and map rankings back", async () => {
    const runSuite = makeRunSuite(() => "USER Alice: hi\n\nASSISTANT openclaw: anonymous reply");
    const runJudge = vi.fn(async (params: CharacterRunJudgeParams) => {
      expect(params.prompt).toContain("## CANDIDATE candidate-01");
      expect(params.prompt).toContain("## CANDIDATE candidate-02");
      expect(params.prompt).not.toContain("openai/gpt-5.6-luna");
      expect(params.prompt).not.toContain("codex-cli/test-model");
      return makeJudgeReply([
        makeRanking("candidate-02", 1, 9.1, "Better vibes."),
        makeRanking("candidate-01", 2, 7.4, "Solid."),
      ]);
    });

    const result = await runEval({
      models: [primaryModel, "codex-cli/test-model"],
      judgeBlindModels: true,
      runSuite,
      runJudge,
    });

    expect(result.judgments[0]?.blindModels).toBe(true);
    expect(result.judgments[0]?.rankings.map((ranking) => ranking.model)).toEqual([
      "codex-cli/test-model",
      "openai/gpt-5.6-luna",
    ]);
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("Judge model labels: blind");
    expect(report).toContain("1. codex-cli/test-model - 9.1 - Better vibes.");
  });

  it.each([
    {
      description: "a missing candidate",
      rankings: [{ model: "openai/gpt-5.6-luna", rank: 1, score: 8, summary: "ok" }],
    },
    {
      description: "a duplicated candidate",
      rankings: [
        { model: "openai/gpt-5.6-luna", rank: 1, score: 8, summary: "ok" },
        { model: "openai/gpt-5.6-luna", rank: 2, score: 7, summary: "again" },
      ],
    },
    {
      description: "duplicated ranks",
      rankings: [makeRanking(primaryModel), makeRanking(kimi, 1, 7)],
    },
    {
      description: "an unknown candidate",
      rankings: [makeRanking(primaryModel), makeRanking("unknown/candidate", 2, 7, "unknown")],
    },
  ])("marks a judge with $description as failed", async ({ rankings }) => {
    const result = await runEval({
      models: [primaryModel, kimi],
      runJudge: makeRunJudge(rankings),
    });

    expect(result.runs.map((run) => run.status)).toEqual(["pass", "pass"]);
    expect(result.judgments[0]).toMatchObject({
      rankings: [],
      error: "judge reply must rank every candidate exactly once with consecutive ranks",
    });
  });

  it("defaults to the character eval model panel when no models are provided", async () => {
    const panel = [
      [primaryModel, "medium", true],
      ["openai/gpt-5.2", "xhigh", true],
      ["openai/gpt-5", "xhigh", true],
      ["anthropic/claude-opus-4-8", "high", false],
      ["anthropic/claude-sonnet-4-6", "high", false],
      ["zai/glm-5.1", "high", false],
      [kimi, "high", false],
      ["google/gemini-3.1-pro-preview", "high", false],
    ] as const;
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge(panel.map(([model], index) => makeRanking(model, index + 1)));

    await runEval({
      models: [],
      judgeModels: undefined,
      runSuite,
      runJudge,
    });

    expect(runSuite).toHaveBeenCalledTimes(8);
    expect(
      runSuite.mock.calls.map(([params]) => [
        params.primaryModel,
        params.thinkingDefault,
        params.fastMode,
      ]),
    ).toEqual(panel);
    expect(runJudge).toHaveBeenCalledTimes(2);
    expect(runJudge.mock.calls.map(([params]) => params)).toMatchObject([
      { judgeModel: primaryModel, judgeThinkingDefault: "xhigh", judgeFastMode: true },
      {
        judgeModel: "anthropic/claude-opus-4-8",
        judgeThinkingDefault: "high",
        judgeFastMode: false,
      },
    ]);
  });

  it("runs candidate models with bounded concurrency while preserving result order", async () => {
    const runGate = createConcurrencyGate(2);
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      runGate.run(() => makeSuiteResult(params)),
    );
    const resultPromise = runEval({
      models: [primaryModel, "anthropic/claude-sonnet-4-6", kimi],
      candidateConcurrency: 2,
      runSuite,
    });

    await runGate.waitForExpectedActive();
    expect(runGate.maxActive).toBe(2);
    runGate.releaseStartedTasks();
    const result = await resultPromise;
    expect(result.runs.map((run) => run.model)).toEqual([
      "openai/gpt-5.6-luna",
      "anthropic/claude-sonnet-4-6",
      "moonshot/kimi-k2.5",
    ]);
  });

  it("defaults candidate and judge concurrency to sixteen", async () => {
    const runGate = createConcurrencyGate(16);
    const judgeGate = createConcurrencyGate(16);
    const models = Array.from({ length: 20 }, (_, index) => `provider/model-${index + 1}`);
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      runGate.run(() => makeSuiteResult(params)),
    );
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) =>
      judgeGate.run(() =>
        makeJudgeReply(models.map((model, index) => makeRanking(model, index + 1, 10 - index))),
      ),
    );

    const resultPromise = runEval({
      models,
      judgeModels: Array.from({ length: 20 }, (_, index) => `judge/model-${index + 1}`),
      runSuite,
      runJudge,
    });

    await runGate.waitForExpectedActive();
    expect(runGate.maxActive).toBe(16);
    runGate.releaseStartedTasks();
    await judgeGate.waitForExpectedActive();
    expect(judgeGate.maxActive).toBe(16);
    judgeGate.releaseStartedTasks();
    await resultPromise;
  });

  it.each([
    {
      title: "marks raw provider error transcripts as failed output",
      transcript:
        "USER Alice: Are you awake?\n\nASSISTANT OpenClaw QA: 400 model `qwen3.6-plus` is not supported.",
      model: "qwen/qwen3.6-plus",
      expectedReason: "model unsupported error leaked into transcript",
    },
    {
      title: "marks generic channel fallback transcripts as failed output",
      transcript:
        "ASSISTANT OpenClaw QA: ⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      model: "qa/generic-fallback-model",
      expectedReason: "generic request failure leaked into transcript",
    },
    {
      title: "marks idle-timeout fallback transcripts as failed output",
      transcript:
        "ASSISTANT OpenClaw QA: The model did not produce a response before the LLM idle timeout. Please try again, or increase `agents.defaults.llm.idleTimeoutSeconds` in your config.",
      model: "google/gemini-test",
      expectedReason: "LLM timeout leaked into transcript",
    },
    {
      title: "marks leaked harness coordination transcripts as failed output",
      transcript:
        "ASSISTANT OpenClaw QA: checking thread context; then post a tight progress reply here.\nQA_LEAK_OK",
      model: "codex/gpt-5.6-luna",
      expectedReason: "internal harness/meta text leaked into transcript",
    },
    {
      title: "marks raw tool failure transcripts as failed output",
      transcript: "ASSISTANT OpenClaw QA: ⚠️ ✍️ Write: to /tmp/precious.html failed",
      model: "qwen/qwen3.5-plus",
      expectedReason: "tool failure leaked into transcript",
    },
  ])("$title", async ({ transcript, model, expectedReason }) => {
    const runSuite = makeRunSuite(() => transcript);
    const result = await runEval({
      models: [model],
      runSuite,
      runJudge: makeRunJudge([makeRanking(model, 1, 0.5, "failed")]),
    });

    expectFirstRunFailure(result, {
      model,
      error: expectedReason,
    });
  });

  it("marks candidates failed when the suite summary has failed scenarios", async () => {
    const result = await runEval({
      runSuite: makeRunSuite(defaultModelTranscript, { summaryStatus: "fail" }),
      runJudge: makeRunJudge([makeRanking(primaryModel, 1, 0.5, "failed")]),
    });

    expect(result.runs[0]?.status).toBe("fail");
    expect(result.runs[0]?.error).toBeUndefined();
  });

  it("rejects a candidate whose suite summary is still running", async () => {
    const result = await runEval({
      runSuite: makeRunSuite(defaultModelTranscript, { runStatus: "running" }),
      runJudge: makeRunJudge([makeRanking(primaryModel, 1, 0.5, "failed")]),
    });

    expect(result.runs[0]).toMatchObject({
      model: primaryModel,
      status: "fail",
      error: expect.stringContaining("still running"),
    });
  });

  it("rejects a passing suite with a user-only conversation", async () => {
    const transcript = "USER Alice: hello?";
    const result = await runEval({
      runSuite: makeRunSuite(() => transcript),
      runJudge: makeRunJudge([makeRanking(primaryModel, 1, 0.5, "no reply")]),
    });

    expectFirstRunFailure(result, {
      model: "openai/gpt-5.6-luna",
      error: "candidate transcript did not contain an assistant reply",
    });
    expect(result.runs[0]?.stats.assistantTurns).toBe(0);
    expect(result.runs[0]?.transcript).toBe(transcript);
  });

  it("lets explicit candidate thinking override the default panel", async () => {
    const runSuite = makeRunSuite();
    await runEval({
      models: [primaryModel, kimi],
      candidateThinkingDefault: "medium",
      candidateThinkingByModel: { "moonshot/kimi-k2.5": "high" },
      runSuite,
    });

    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "medium",
      "high",
    ]);
  });

  it("lets model-specific options override candidate and judge defaults", async () => {
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge([makeRanking(primaryModel), makeRanking(kimi, 2, 7)]);

    await runEval({
      models: [primaryModel, kimi],
      candidateFastMode: true,
      candidateThinkingDefault: "medium",
      candidateModelOptions: {
        "openai/gpt-5.6-luna": { thinkingDefault: "xhigh", fastMode: false },
      },
      judgeModels: ["openai/gpt-5.6-luna", "anthropic/claude-opus-4-8"],
      judgeModelOptions: {
        "openai/gpt-5.6-luna": { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-8": { thinkingDefault: "high" },
      },
      runSuite,
      runJudge,
    });

    expect(runSuite.mock.calls.map(([params]) => params)).toMatchObject([
      { thinkingDefault: "xhigh", fastMode: false },
      { thinkingDefault: "medium", fastMode: true },
    ]);
    expect(runJudge.mock.calls.map(([params]) => params)).toMatchObject([
      { judgeThinkingDefault: "xhigh", judgeFastMode: true },
      { judgeThinkingDefault: "high", judgeFastMode: false },
    ]);
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
        rankings: [
          { model: "openai/gpt-5.6-luna", rank: 1, score: 8, summary: "ok" },
          { model: "codex-cli/test-model", rank: 2, score: 0, summary: "failed" },
        ],
      }),
    );

    const result = await runEval({
      models: ["openai/gpt-5.6-luna", "codex-cli/test-model"],
      judgeModels: ["openai/gpt-5.6-luna"],
      runSuite,
      runJudge,
    });

    expect(result.runs.map((run) => run.status)).toEqual(["pass", "fail"]);
    expect(result.runs[1]?.error).toContain("backend unavailable");
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("backend unavailable");
  });
});
