import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaCharacterEval } from "./character-eval.js";
import * as manualLaneRuntime from "./manual-lane.runtime.js";
import * as suiteLaunchRuntime from "./suite-launch.runtime.js";
import { makeQaSuiteTestScenario, recordQaSuiteTestResults } from "./suite-test-helpers.js";
import type { QaSuiteResult } from "./suite.js";

type CharacterRunSuiteParams = NonNullable<
  Parameters<typeof suiteLaunchRuntime.runQaFlowSuiteFromRuntime>[0]
> & {
  outputDir: string;
  primaryModel: string;
};
type CharacterRunJudgeParams = Parameters<typeof manualLaneRuntime.runQaManualLane>[0];
type QaCharacterEvalParams = Parameters<typeof runQaCharacterEval>[0] & {
  runSuite: (params: CharacterRunSuiteParams) => Promise<QaSuiteResult>;
  runJudge: typeof manualLaneRuntime.runQaManualLane;
};
type QaCharacterEvalJudgment = Awaited<
  ReturnType<typeof runQaCharacterEval>
>["judgments"][number]["rankings"][number];
type TestJudgeRanking = Pick<QaCharacterEvalJudgment, "model" | "rank" | "score" | "summary"> &
  Partial<Pick<QaCharacterEvalJudgment, "strengths" | "weaknesses">>;

const primary = "openai/gpt-5.6-luna";
const alternate = "codex-cli/test-model";
const kimi = "moonshot/kimi-k2.5";

function ranking(model = primary, rank = 1, score = 8, summary = "ok"): TestJudgeRanking {
  return { model, rank, score, summary };
}

function makeJudgeResult(params: CharacterRunJudgeParams, rankings: TestJudgeRanking[]) {
  return {
    model: params.primaryModel,
    waited: { status: "completed" },
    reply: JSON.stringify({ rankings }),
    watchUrl: "http://127.0.0.1:43124",
  } satisfies Awaited<ReturnType<typeof manualLaneRuntime.runQaManualLane>>;
}

function makeRunJudge(rankings: TestJudgeRanking[] = [ranking()]) {
  return vi.fn(async (params: CharacterRunJudgeParams) => makeJudgeResult(params, rankings));
}

function defaultModelTranscript(model: string) {
  return `USER Alice: hi\n\nASSISTANT openclaw: reply from ${model}`;
}

function makeReplySuiteResult(
  params: CharacterRunSuiteParams,
  transcript = defaultModelTranscript(params.primaryModel),
  overrides: Partial<Parameters<typeof makeSuiteResult>[0]> = {},
) {
  return makeSuiteResult({
    outputDir: params.outputDir,
    model: params.primaryModel,
    transcript,
    ...overrides,
  });
}

function makeRunSuite(transcriptForModel: (model: string) => string = defaultModelTranscript) {
  return vi.fn(async (params: CharacterRunSuiteParams) =>
    makeReplySuiteResult(params, transcriptForModel(params.primaryModel)),
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

async function makeSuiteResult(params: {
  outputDir: string;
  model: string;
  transcript: string;
  resultStatus?: "pass" | "fail";
  summaryStatus?: "pass" | "fail";
  summaryFailedCount?: number;
  runStatus?: "running" | "completed";
}) {
  const resultStatus = params.resultStatus ?? "pass";
  const summaryStatus = params.summaryStatus ?? resultStatus;
  const summaryFailedCount = params.summaryFailedCount ?? (summaryStatus === "fail" ? 1 : 0);
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  await fs.mkdir(params.outputDir, { recursive: true });
  const summary = {
    run: { status: params.runStatus ?? "completed" },
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
          status: resultStatus,
          steps: [
            {
              name: `transcript for ${params.model}`,
              status: "pass",
              details: params.transcript,
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
  const run = result.runs[0];
  expect(run).toMatchObject({ ...expected, status: "fail" });
}

describe("runQaCharacterEval", () => {
  let tempRoot: string;

  function runEval(params: Partial<QaCharacterEvalParams> = {}) {
    const { runSuite = makeRunSuite(), runJudge = makeRunJudge(), ...options } = params;
    vi.spyOn(suiteLaunchRuntime, "runQaFlowSuiteFromRuntime").mockImplementation(
      async (suiteParams) => {
        if (!suiteParams?.outputDir || !suiteParams.primaryModel) {
          throw new Error("character eval suite parameters missing");
        }
        return runSuite({
          ...suiteParams,
          outputDir: suiteParams.outputDir,
          primaryModel: suiteParams.primaryModel,
        });
      },
    );
    vi.spyOn(manualLaneRuntime, "runQaManualLane").mockImplementation(runJudge);
    return runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: [primary],
      judgeModels: [primary],
      ...options,
    });
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-character-eval-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("runs each requested model and writes a judged report with transcripts", async () => {
    const runSuite = makeRunSuite(
      (model) => `USER Alice: prompt for ${model}\n\nASSISTANT openclaw: reply from ${model}`,
    );
    const runJudge = makeRunJudge([
      { ...ranking(primary, 1, 9.1, "Most natural."), strengths: ["vivid"], weaknesses: ["none"] },
      {
        ...ranking(alternate, 2, 7, "Readable but flatter."),
        strengths: ["coherent"],
        weaknesses: ["less funny"],
      },
    ]);

    const result = await runEval({
      models: [primary, alternate, primary],
      scenarioId: "character-vibes-gollum",
      candidateFastMode: true,
      judgeModels: [primary],
      runSuite,
      runJudge,
    });

    expect(result.runs.map((run) => run.error)).toEqual([undefined, undefined]);
    expect(runSuite).toHaveBeenCalledTimes(2);
    expect(runSuite.mock.calls[0]?.[0]).toMatchObject({
      providerMode: "live-frontier",
      primaryModel: primary,
      alternateModel: primary,
      fastMode: true,
      scenarioIds: ["character-vibes-gollum"],
    });
    expect(runJudge.mock.calls[0]?.[0]).toMatchObject({
      providerMode: "live-frontier",
      primaryModel: primary,
      alternateModel: primary,
      thinkingDefault: "xhigh",
      fastMode: true,
      timeoutMs: 300_000,
    });
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]?.rankings.map((entry) => entry.model)).toEqual([primary, alternate]);

    const report = await fs.readFile(result.reportPath, "utf8");
    for (const text of [
      "Execution: local QA gateway child processes, not Docker",
      `Judges: ${primary}`,
      "Judge model labels: visible",
      "## Judge Rankings",
      `### ${primary}`,
      `reply from ${primary}`,
      `reply from ${alternate}`,
      "Judge thinking: xhigh",
      "- Timeout: 5m",
      "Fast mode: on",
      "Duration:",
    ]) {
      expect(report).toContain(text);
    }
    for (const text of ["Duration ms:", "Judge Raw Reply"]) {
      expect(report).not.toContain(text);
    }
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
      const result = await makeReplySuiteResult(params);
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
      judgeModels: [primary],
      runSuite,
      runJudge: makeRunJudge([
        ranking(firstModel, 1, 8, "first"),
        ranking(secondModel, 2, 7, "second"),
      ]),
    });

    expect(runSuite).toHaveBeenCalledTimes(2);
    expect.soft(new Set(result.runs.map((run) => run.outputDir)).size).toBe(models.length);
    expect
      .soft(
        new Set(result.runs.flatMap((run) => ("summaryPath" in run ? [run.summaryPath] : []))).size,
      )
      .toBe(models.length);
    await expect
      .soft(
        Promise.all(
          result.runs.map((run) =>
            fs.readFile(path.join(run.outputDir, "model-marker.txt"), "utf8"),
          ),
        ),
      )
      .resolves.toEqual(models.map((model) => `${model}\n`));
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
      expect(params.message).toContain("## CANDIDATE candidate-01");
      expect(params.message).toContain("## CANDIDATE candidate-02");
      expect(params.message).not.toContain(primary);
      expect(params.message).not.toContain(alternate);
      return makeJudgeResult(params, [
        ranking("candidate-02", 1, 9.1, "Better vibes."),
        ranking("candidate-01", 2, 7.4, "Solid."),
      ]);
    });

    const result = await runEval({
      models: [primary, alternate],
      judgeBlindModels: true,
      runSuite,
      runJudge,
    });

    expect(result.judgments[0]?.blindModels).toBe(true);
    expect(result.judgments[0]?.rankings.map((entry) => entry.model)).toEqual([alternate, primary]);
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("Judge model labels: blind");
    expect(report).toContain("1. codex-cli/test-model - 9.1 - Better vibes.");
  });

  it.each<[string, TestJudgeRanking[]]>([
    ["a missing candidate", [ranking()]],
    ["a duplicated candidate", [ranking(), ranking(primary, 2, 7, "again")]],
    ["duplicated ranks", [ranking(), ranking(kimi, 1, 7)]],
    ["an unknown candidate", [ranking(), ranking("unknown/candidate", 2, 7, "unknown")]],
  ])("marks a judge with %s as failed", async (_description, rankings) => {
    const result = await runEval({
      models: [primary, kimi],
      runJudge: makeRunJudge(rankings),
    });

    expect(result.runs.map((run) => run.status)).toEqual(["pass", "pass"]);
    expect(result.judgments[0]).toMatchObject({
      rankings: [],
      error: "judge reply must rank every candidate exactly once with consecutive ranks",
    });
  });

  it("defaults to the character eval model panel when no models are provided", async () => {
    const runSuite = makeRunSuite();
    const panel = [
      [primary, "medium", true],
      ["openai/gpt-5.2", "xhigh", true],
      ["openai/gpt-5", "xhigh", true],
      ["anthropic/claude-opus-4-8", "high", false],
      ["anthropic/claude-sonnet-4-6", "high", false],
      ["zai/glm-5.1", "high", false],
      [kimi, "high", false],
      ["google/gemini-3.1-pro-preview", "high", false],
    ] as const;
    const runJudge = makeRunJudge(panel.map(([model], index) => ranking(model, index + 1)));

    await runEval({
      models: [],
      judgeModels: [],
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
    expect(runJudge.mock.calls.map(([params]) => params.primaryModel)).toEqual([
      primary,
      "anthropic/claude-opus-4-8",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "xhigh",
      "high",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.fastMode)).toEqual([true, false]);
  });

  it("runs candidate models with bounded concurrency while preserving result order", async () => {
    const runGate = createConcurrencyGate(2);
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      runGate.run(() => makeReplySuiteResult(params)),
    );
    const runJudge = makeRunJudge([
      ranking(),
      ranking("anthropic/claude-sonnet-4-6", 2, 7),
      ranking(kimi, 3, 6),
    ]);

    const resultPromise = runEval({
      models: [primary, "anthropic/claude-sonnet-4-6", kimi],
      candidateConcurrency: 2,
      judgeModels: [primary],
      runSuite,
      runJudge,
    });

    await runGate.waitForExpectedActive();
    expect(runGate.maxActive).toBe(2);
    runGate.releaseStartedTasks();
    const result = await resultPromise;
    expect(result.runs.map((run) => run.model)).toEqual([
      primary,
      "anthropic/claude-sonnet-4-6",
      kimi,
    ]);
  });

  it("defaults candidate and judge concurrency to sixteen", async () => {
    const runGate = createConcurrencyGate(16);
    const judgeGate = createConcurrencyGate(16);
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      runGate.run(() => makeReplySuiteResult(params)),
    );
    const runJudge = vi.fn(async (params: CharacterRunJudgeParams) => {
      return await judgeGate.run(() =>
        makeJudgeResult(
          params,
          Array.from({ length: 20 }, (_, index) =>
            ranking(`provider/model-${index + 1}`, index + 1, 10 - index),
          ),
        ),
      );
    });

    const resultPromise = runEval({
      models: Array.from({ length: 20 }, (_, index) => `provider/model-${index + 1}`),
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
    const result = await runEval({
      models: [model],
      runSuite: makeRunSuite(() => transcript),
      runJudge: makeRunJudge([ranking(model, 1, 0.5, "failed")]),
    });

    expectFirstRunFailure(result, { model, error: expectedReason });
  });

  it("marks candidates failed when the suite summary has failed scenarios", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeReplySuiteResult(params, "USER Alice: hi\n\nASSISTANT openclaw: outwardly fine", {
        summaryStatus: "fail",
        summaryFailedCount: 1,
      }),
    );
    const result = await runEval({ runSuite });

    expect(result.runs[0]?.status).toBe("fail");
    expect(result.runs[0]?.error).toBeUndefined();
  });

  it("rejects a candidate whose suite summary is still running", async () => {
    const result = await runEval({
      runSuite: async (params) =>
        makeReplySuiteResult(params, "USER Alice: hi\n\nASSISTANT openclaw: partial reply", {
          runStatus: "running",
        }),
    });

    expect(result.runs[0]).toMatchObject({
      model: primary,
      status: "fail",
      error: expect.stringContaining("still running"),
    });
  });

  it("rejects a passing suite with a user-only conversation", async () => {
    const transcript = "USER Alice: hello?";
    const result = await runEval({ runSuite: makeRunSuite(() => transcript) });

    expectFirstRunFailure(result, {
      model: primary,
      error: "candidate transcript did not contain an assistant reply",
    });
    expect(result.runs[0]?.stats.assistantTurns).toBe(0);
    expect(result.runs[0]?.transcript).toBe(transcript);
  });

  it("lets explicit candidate thinking override the default panel", async () => {
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge([ranking(), ranking(kimi, 2, 7)]);

    await runEval({
      models: [primary, kimi],
      candidateThinkingDefault: "medium",
      candidateThinkingByModel: { [kimi]: "high" },
      judgeModels: [primary],
      runSuite,
      runJudge,
    });

    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "medium",
      "high",
    ]);
  });

  it("lets model-specific options override candidate and judge defaults", async () => {
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge([ranking(), ranking(kimi, 2, 7)]);

    await runEval({
      models: [primary, kimi],
      candidateFastMode: true,
      candidateThinkingDefault: "medium",
      candidateModelOptions: {
        [primary]: { thinkingDefault: "xhigh", fastMode: false },
      },
      judgeModels: [primary, "anthropic/claude-opus-4-8"],
      judgeModelOptions: {
        [primary]: { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-8": { thinkingDefault: "high" },
      },
      runSuite,
      runJudge,
    });

    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "xhigh",
      "medium",
    ]);
    expect(runSuite.mock.calls.map(([params]) => params.fastMode)).toEqual([false, true]);
    expect(runJudge.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "xhigh",
      "high",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.fastMode)).toEqual([true, false]);
  });

  it("keeps failed model runs in the report for grader context", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      if (params.primaryModel === alternate) {
        throw new Error("backend unavailable");
      }
      return makeReplySuiteResult(params, "USER Alice: hi\n\nASSISTANT openclaw: hello");
    });
    const runJudge = vi.fn(async (params: CharacterRunJudgeParams) =>
      makeJudgeResult(params, [ranking(), ranking(alternate, 2, 0, "failed")]),
    );

    const result = await runEval({
      models: [primary, alternate],
      judgeModels: [primary],
      runSuite,
      runJudge,
    });

    expect(result.runs.map((run) => run.status)).toEqual(["pass", "fail"]);
    expect(result.runs[1]?.error).toContain("backend unavailable");
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("backend unavailable");
  });
});
