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

async function makeReplySuiteResult(
  params: CharacterRunSuiteParams,
  transcript = defaultModelTranscript(params.primaryModel),
  summaryStatus: "pass" | "fail" = "pass",
) {
  const failed = summaryStatus === "fail" ? 1 : 0;
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  await fs.mkdir(params.outputDir, { recursive: true });
  const summary = {
    run: { status: "completed" },
    counts: { total: 1, passed: 1 - failed, failed },
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
              details: transcript,
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

  it("deduplicates model refs, isolates colliding slugs, and reports each judged transcript", async () => {
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
      models: [...models, firstModel],
      candidateConcurrency: 2,
      judgeModels: [primary],
      runSuite,
      runJudge: makeRunJudge([
        {
          ...ranking(firstModel, 1, 9.1, "Most natural."),
          strengths: ["vivid"],
          weaknesses: ["none"],
        },
        {
          ...ranking(secondModel, 2, 7, "Readable but flatter."),
          strengths: ["coherent"],
          weaknesses: ["less funny"],
        },
      ]),
    });

    expect(result.runs.map((run) => run.model)).toEqual(models);
    expect(result.runs.map((run) => run.error)).toEqual([undefined, undefined]);
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]?.rankings.map((entry) => entry.model)).toEqual(models);
    const report = await fs.readFile(result.reportPath, "utf8");
    for (const text of [`reply from ${firstModel}`, `reply from ${secondModel}`, "Most natural."]) {
      expect(report).toContain(text);
    }
    expect(report).not.toContain("Judge Raw Reply");
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

  it("uses default candidate and judge settings without an explicit panel", async () => {
    const runSuite = makeRunSuite();
    const result = await runEval({
      models: [],
      judgeModels: [],
      runSuite,
      runJudge: async (params) =>
        makeJudgeResult(
          params,
          runSuite.mock.calls.map(([call], index) => ranking(call.primaryModel, index + 1)),
        ),
    });
    expect(result.runs[0]).toMatchObject({
      model: primary,
      thinkingDefault: "medium",
      fastMode: true,
    });
    expect(
      result.judgments.map(({ model, thinkingDefault, fastMode }) => [
        model,
        thinkingDefault,
        fastMode,
      ]),
    ).toEqual([
      [primary, "xhigh", true],
      ["anthropic/claude-opus-4-8", "high", false],
    ]);
  });

  it.each([
    { limit: 2, count: 3, options: { candidateConcurrency: 2, judgeConcurrency: 2 } },
    { limit: 16, count: 20, options: {} },
  ])(
    "bounds candidate and judge concurrency to $limit and preserves order",
    async ({ limit, count, options }) => {
      const models = Array.from({ length: count }, (_, index) => `provider/model-${index}`);
      const judges = Array.from({ length: count }, (_, index) => `judge/model-${index}`);
      const runGate = createConcurrencyGate(limit);
      const judgeGate = createConcurrencyGate(limit);
      const resultPromise = runEval({
        ...options,
        models,
        judgeModels: judges,
        runSuite: (params) => runGate.run(() => makeReplySuiteResult(params)),
        runJudge: (params) =>
          judgeGate.run(() =>
            makeJudgeResult(
              params,
              models.map((model, index) => ranking(model, index + 1)),
            ),
          ),
      });
      await runGate.waitForExpectedActive();
      expect(runGate.maxActive).toBe(limit);
      runGate.releaseStartedTasks();
      await judgeGate.waitForExpectedActive();
      expect(judgeGate.maxActive).toBe(limit);
      judgeGate.releaseStartedTasks();
      const result = await resultPromise;
      expect(result.runs.map((run) => run.model)).toEqual(models);
    },
  );

  it.each([
    ["400 model `qwen3.6-plus` is not supported.", "model unsupported error"],
    [
      "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      "generic request failure",
    ],
    [
      "The model did not produce a response before the LLM idle timeout. Please try again, or increase `agents.defaults.llm.idleTimeoutSeconds` in your config.",
      "LLM timeout",
    ],
    [
      "checking thread context; then post a tight progress reply here.\nQA_LEAK_OK",
      "internal harness/meta text",
    ],
    ["⚠️ ✍️ Write: to /tmp/precious.html failed", "tool failure"],
  ])("rejects a transcript containing %s", async (reply, reason) => {
    const result = await runEval({
      runSuite: makeRunSuite(() => `ASSISTANT OpenClaw QA: ${reply}`),
    });
    expectFirstRunFailure(result, { model: primary, error: `${reason} leaked into transcript` });
  });

  it("marks candidates failed when the suite summary has failed scenarios", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeReplySuiteResult(params, "USER Alice: hi\n\nASSISTANT openclaw: outwardly fine", "fail"),
    );
    const result = await runEval({ runSuite });

    expect(result.runs[0]?.status).toBe("fail");
    expect(result.runs[0]?.error).toBeUndefined();
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

  it.each([
    {
      name: "per-model thinking",
      options: { candidateThinkingByModel: { [kimi]: "high" as const } },
      candidate: [
        ["medium", true],
        ["high", true],
      ],
    },
    {
      name: "model options",
      options: {
        candidateModelOptions: {
          [primary]: { thinkingDefault: "xhigh" as const, fastMode: false },
        },
      },
      candidate: [
        ["xhigh", false],
        ["medium", true],
      ],
    },
  ])("applies $name over candidate defaults", async ({ options, candidate }) => {
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge([ranking(), ranking(kimi, 2, 7)]);
    await runEval({
      models: [primary, kimi],
      candidateThinkingDefault: "medium",
      candidateFastMode: true,
      ...options,
      runSuite,
      runJudge,
      judgeModels: [primary, "anthropic/claude-opus-4-8"],
      judgeModelOptions: {
        [primary]: { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-8": { thinkingDefault: "high" },
      },
    });
    const settings = ({
      thinkingDefault,
      fastMode,
    }: {
      thinkingDefault?: string;
      fastMode?: boolean;
    }) => [thinkingDefault, fastMode];
    expect(runSuite.mock.calls.map(([params]) => settings(params))).toEqual(candidate);
    expect(runJudge.mock.calls.map(([params]) => settings(params))).toEqual([
      ["xhigh", true],
      ["high", false],
    ]);
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
