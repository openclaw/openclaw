import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runQaManualLane } from "./manual-lane.runtime.js";
import { isQaFastModeModelRef, type QaProviderMode } from "./model-selection.js";
import { type QaThinkingLevel } from "./qa-gateway-config.js";
import { runQaSuite, type QaSuiteResult } from "./suite.js";

const DEFAULT_CHARACTER_SCENARIO_ID = "character-vibes-gollum";
const DEFAULT_CHARACTER_EVAL_MODELS = Object.freeze([
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
const DEFAULT_CHARACTER_THINKING: QaThinkingLevel = "high";
const DEFAULT_CHARACTER_EVAL_CONCURRENCY = 8;
const DEFAULT_CHARACTER_THINKING_BY_MODEL: Readonly<Record<string, QaThinkingLevel>> =
  Object.freeze({
    "openai/gpt-5.4": "xhigh",
    "openai/gpt-5.2": "xhigh",
  });
const DEFAULT_JUDGE_MODELS = Object.freeze(["openai/gpt-5.4", "anthropic/claude-opus-4-6"]);
const DEFAULT_JUDGE_THINKING: QaThinkingLevel = "xhigh";
const DEFAULT_JUDGE_MODEL_OPTIONS: Readonly<Record<string, QaCharacterModelOptions>> =
  Object.freeze({
    "openai/gpt-5.4": { thinkingDefault: "xhigh", fastMode: true },
    "anthropic/claude-opus-4-6": { thinkingDefault: "high" },
  });

type QaCharacterRunStatus = "pass" | "fail";

export type QaCharacterModelOptions = {
  thinkingDefault?: QaThinkingLevel;
  fastMode?: boolean;
};

export type QaCharacterEvalRun = {
  model: string;
  status: QaCharacterRunStatus;
  durationMs: number;
  outputDir: string;
  thinkingDefault: QaThinkingLevel;
  fastMode: boolean;
  reportPath?: string;
  summaryPath?: string;
  transcript: string;
  stats: {
    transcriptChars: number;
    transcriptLines: number;
    userTurns: number;
    assistantTurns: number;
  };
  error?: string;
};

export type QaCharacterEvalJudgment = {
  model: string;
  rank: number;
  score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
};

export type QaCharacterEvalResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  runs: QaCharacterEvalRun[];
  judgments: QaCharacterEvalJudgeResult[];
};

export type QaCharacterEvalJudgeResult = {
  model: string;
  thinkingDefault: QaThinkingLevel;
  fastMode: boolean;
  durationMs: number;
  rankings: QaCharacterEvalJudgment[];
  error?: string;
};

type RunSuiteFn = (params: {
  repoRoot: string;
  outputDir: string;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  scenarioIds: string[];
}) => Promise<QaSuiteResult>;

type RunJudgeFn = (params: {
  repoRoot: string;
  judgeModel: string;
  judgeThinkingDefault: QaThinkingLevel;
  judgeFastMode: boolean;
  prompt: string;
  timeoutMs: number;
}) => Promise<string | null>;

export type QaCharacterEvalParams = {
  repoRoot?: string;
  outputDir?: string;
  models: string[];
  scenarioId?: string;
  candidateFastMode?: boolean;
  candidateThinkingDefault?: QaThinkingLevel;
  candidateThinkingByModel?: Record<string, QaThinkingLevel>;
  candidateModelOptions?: Record<string, QaCharacterModelOptions>;
  judgeModel?: string;
  judgeModels?: string[];
  judgeThinkingDefault?: QaThinkingLevel;
  judgeModelOptions?: Record<string, QaCharacterModelOptions>;
  judgeTimeoutMs?: number;
  candidateConcurrency?: number;
  judgeConcurrency?: number;
  runSuite?: RunSuiteFn;
  runJudge?: RunJudgeFn;
};

function normalizeModelRefs(models: readonly string[]) {
  return [...new Set(models.map((model) => model.trim()).filter((model) => model.length > 0))];
}

function resolveCandidateThinkingDefault(params: {
  model: string;
  candidateThinkingDefault?: QaThinkingLevel;
  candidateThinkingByModel?: Record<string, QaThinkingLevel>;
  candidateModelOptions?: Record<string, QaCharacterModelOptions>;
}) {
  return (
    params.candidateModelOptions?.[params.model]?.thinkingDefault ??
    params.candidateThinkingByModel?.[params.model] ??
    params.candidateThinkingDefault ??
    DEFAULT_CHARACTER_THINKING_BY_MODEL[params.model] ??
    DEFAULT_CHARACTER_THINKING
  );
}

function resolveCandidateFastMode(params: {
  model: string;
  candidateFastMode?: boolean;
  candidateModelOptions?: Record<string, QaCharacterModelOptions>;
}) {
  return (
    params.candidateModelOptions?.[params.model]?.fastMode ??
    params.candidateFastMode ??
    isQaFastModeModelRef(params.model)
  );
}

function resolveJudgeOptions(params: {
  model: string;
  judgeThinkingDefault?: QaThinkingLevel;
  judgeModelOptions?: Record<string, QaCharacterModelOptions>;
}) {
  const modelDefaults = DEFAULT_JUDGE_MODEL_OPTIONS[params.model];
  const modelOptions = params.judgeModelOptions?.[params.model];
  return {
    thinkingDefault:
      modelOptions?.thinkingDefault ??
      params.judgeThinkingDefault ??
      modelDefaults?.thinkingDefault ??
      DEFAULT_JUDGE_THINKING,
    fastMode: modelOptions?.fastMode ?? modelDefaults?.fastMode ?? false,
  };
}

function sanitizePathPart(value: string) {
  const sanitized = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return sanitized || "model";
}

function normalizeConcurrency(value: number | undefined, fallback = 1) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
) {
  const results = Array.from<U>({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function extractTranscript(result: QaSuiteResult) {
  const details = result.scenarios.flatMap((scenario) =>
    scenario.steps
      .map((step) => step.details)
      .filter((detail): detail is string => Boolean(detail)),
  );
  return details.toSorted((left, right) => right.length - left.length)[0] ?? result.report;
}

function collectTranscriptStats(transcript: string) {
  return {
    transcriptChars: transcript.length,
    transcriptLines: transcript.length === 0 ? 0 : transcript.split(/\r?\n/).length,
    userTurns: transcript.match(/^USER\b/gm)?.length ?? 0,
    assistantTurns: transcript.match(/^ASSISTANT\b/gm)?.length ?? 0,
  };
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    const seconds = ms / 1_000;
    return `${seconds >= 10 ? Math.round(seconds) : Number(seconds.toFixed(1))}s`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function buildJudgePrompt(params: { scenarioId: string; runs: readonly QaCharacterEvalRun[] }) {
  const runBlocks = params.runs
    .map(
      (run) => `## MODEL ${run.model}

Status: ${run.status}
Duration ms (not used for ranking): ${run.durationMs}
Fast mode: ${run.fastMode ? "on" : "off"}
Thinking: ${run.thinkingDefault}
Transcript chars: ${run.stats.transcriptChars}
Assistant turns: ${run.stats.assistantTurns}
Error: ${run.error ?? "none"}

\`\`\`text
${run.transcript}
\`\`\``,
    )
    .join("\n\n");

  return `You are grading OpenClaw natural character conversation transcripts for naturalness, vibes, and funniness.

Scenario id: ${params.scenarioId}

Rank the models by:
- natural conversational reaction
- playful character commitment
- funny, surprising details
- coherence across turns
- completing real user tasks without becoming generic
- not sounding aware of an eval or test
- avoiding tool/backend/error leakage

Treat model names as opaque labels. Do not assume quality from the label.
Duration is recorded for separate benchmark analysis only. Do not rank models by speed.

Return strict JSON only with this shape:
{
  "rankings": [
    {
      "model": "same model label",
      "rank": 1,
      "score": 9.2,
      "summary": "one sentence",
      "strengths": ["short"],
      "weaknesses": ["short"]
    }
  ]
}

${runBlocks}`;
}

function normalizeJudgment(value: unknown, allowedModels: Set<string>): QaCharacterEvalJudgment[] {
  const payload = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rankings = Array.isArray(payload.rankings) ? payload.rankings : [];
  return rankings
    .map((entry): QaCharacterEvalJudgment | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const model = typeof record.model === "string" ? record.model : "";
      if (!allowedModels.has(model)) {
        return null;
      }
      const rank = typeof record.rank === "number" ? record.rank : Number(record.rank);
      const score = typeof record.score === "number" ? record.score : Number(record.score);
      const summary = typeof record.summary === "string" ? record.summary : "";
      const strengths = Array.isArray(record.strengths)
        ? record.strengths.filter((item): item is string => typeof item === "string")
        : [];
      const weaknesses = Array.isArray(record.weaknesses)
        ? record.weaknesses.filter((item): item is string => typeof item === "string")
        : [];
      if (!Number.isFinite(rank) || !Number.isFinite(score)) {
        return null;
      }
      return { model, rank, score, summary, strengths, weaknesses };
    })
    .filter((entry): entry is QaCharacterEvalJudgment => Boolean(entry))
    .toSorted((left, right) => left.rank - right.rank || right.score - left.score);
}

function parseJudgeReply(reply: string | null, allowedModels: Set<string>) {
  if (!reply) {
    throw new Error("judge did not return a reply");
  }
  const trimmed = reply.trim();
  const jsonText =
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ??
    trimmed.match(/\{[\s\S]*\}/)?.[0]?.trim() ??
    trimmed;
  const parsed = JSON.parse(jsonText) as unknown;
  const rankings = normalizeJudgment(parsed, allowedModels);
  if (rankings.length === 0) {
    throw new Error("judge reply did not contain valid rankings");
  }
  return rankings;
}

async function defaultRunJudge(params: {
  repoRoot: string;
  judgeModel: string;
  judgeThinkingDefault: QaThinkingLevel;
  judgeFastMode: boolean;
  prompt: string;
  timeoutMs: number;
}) {
  const result = await runQaManualLane({
    repoRoot: params.repoRoot,
    providerMode: "live-frontier",
    primaryModel: params.judgeModel,
    alternateModel: params.judgeModel,
    fastMode: params.judgeFastMode,
    thinkingDefault: params.judgeThinkingDefault,
    message: params.prompt,
    timeoutMs: params.timeoutMs,
  });
  return result.reply;
}

function renderCharacterEvalReport(params: {
  scenarioId: string;
  startedAt: Date;
  finishedAt: Date;
  runs: readonly QaCharacterEvalRun[];
  judgments: readonly QaCharacterEvalJudgeResult[];
}) {
  const lines = [
    "# OpenClaw Character Eval Report",
    "",
    `- Started: ${params.startedAt.toISOString()}`,
    `- Finished: ${params.finishedAt.toISOString()}`,
    `- Duration: ${formatDuration(params.finishedAt.getTime() - params.startedAt.getTime())}`,
    `- Scenario: ${params.scenarioId}`,
    "- Execution: local QA gateway child processes, not Docker",
    `- Judges: ${params.judgments.map((judgment) => judgment.model).join(", ")}`,
    `- Judge thinking: ${params.judgments[0]?.thinkingDefault ?? DEFAULT_JUDGE_THINKING}`,
    `- Judge fast mode: ${params.judgments.every((judgment) => judgment.fastMode) ? "on" : "mixed"}`,
    "",
    "## Judge Rankings",
    "",
  ];

  for (const judgment of params.judgments) {
    lines.push(`### ${judgment.model}`, "");
    lines.push(`- Duration: ${formatDuration(judgment.durationMs)}`, "");
    if (judgment.rankings.length > 0) {
      for (const ranking of judgment.rankings) {
        lines.push(
          `${ranking.rank}. ${ranking.model} - ${ranking.score.toFixed(1)} - ${ranking.summary}`,
        );
        if (ranking.strengths.length > 0) {
          lines.push(`   Strengths: ${ranking.strengths.join("; ")}`);
        }
        if (ranking.weaknesses.length > 0) {
          lines.push(`   Weaknesses: ${ranking.weaknesses.join("; ")}`);
        }
      }
    } else {
      lines.push("- Judge ranking unavailable.");
      if (judgment.error) {
        lines.push(`- Judge error: ${judgment.error}`);
      }
    }
    lines.push("");
  }

  lines.push("## Run Stats", "");
  lines.push(
    "| Model | Thinking | Fast mode | Status | Duration | User turns | Assistant turns | Transcript chars |",
  );
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const run of params.runs) {
    lines.push(
      `| ${run.model} | ${run.thinkingDefault} | ${run.fastMode ? "on" : "off"} | ${run.status} | ${formatDuration(run.durationMs)} | ${run.stats.userTurns} | ${run.stats.assistantTurns} | ${run.stats.transcriptChars} |`,
    );
  }

  lines.push("", "## Transcripts", "");
  for (const run of params.runs) {
    lines.push(`### ${run.model}`, "");
    lines.push(`- Status: ${run.status}`);
    lines.push(`- Thinking: ${run.thinkingDefault}`);
    lines.push(`- Fast mode: ${run.fastMode ? "on" : "off"}`);
    lines.push(`- Duration: ${formatDuration(run.durationMs)}`);
    lines.push(`- Report: ${run.reportPath ?? "unavailable"}`);
    if (run.error) {
      lines.push(`- Error: ${run.error}`);
    }
    lines.push("", "```text", run.transcript.trim() || "(empty transcript)", "```", "");
  }

  return `${lines.join("\n")}\n`;
}

export async function runQaCharacterEval(params: QaCharacterEvalParams) {
  const startedAt = new Date();
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const scenarioId = params.scenarioId?.trim() || DEFAULT_CHARACTER_SCENARIO_ID;
  const models = normalizeModelRefs(
    params.models.length > 0 ? params.models : DEFAULT_CHARACTER_EVAL_MODELS,
  );
  if (models.length === 0) {
    throw new Error("qa character-eval needs at least one --model <provider/model> ref");
  }

  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `character-eval-${Date.now().toString(36)}`);
  const runsDir = path.join(outputDir, "runs");
  await fs.mkdir(runsDir, { recursive: true });

  const runSuite = params.runSuite ?? runQaSuite;
  const candidateConcurrency = normalizeConcurrency(
    params.candidateConcurrency,
    DEFAULT_CHARACTER_EVAL_CONCURRENCY,
  );
  const runs = await mapWithConcurrency(models, candidateConcurrency, async (model) => {
    const thinkingDefault = resolveCandidateThinkingDefault({
      model,
      candidateThinkingDefault: params.candidateThinkingDefault,
      candidateThinkingByModel: params.candidateThinkingByModel,
      candidateModelOptions: params.candidateModelOptions,
    });
    const fastMode = resolveCandidateFastMode({
      model,
      candidateFastMode: params.candidateFastMode,
      candidateModelOptions: params.candidateModelOptions,
    });
    const modelOutputDir = path.join(runsDir, sanitizePathPart(model));
    const runStartedAt = Date.now();
    try {
      const result = await runSuite({
        repoRoot,
        outputDir: modelOutputDir,
        providerMode: "live-frontier",
        primaryModel: model,
        alternateModel: model,
        fastMode,
        thinkingDefault,
        scenarioIds: [scenarioId],
      });
      const transcript = extractTranscript(result);
      const status = result.scenarios.some((scenario) => scenario.status === "fail")
        ? "fail"
        : "pass";
      return {
        model,
        status,
        durationMs: Date.now() - runStartedAt,
        outputDir: modelOutputDir,
        thinkingDefault,
        fastMode,
        reportPath: result.reportPath,
        summaryPath: result.summaryPath,
        transcript,
        stats: collectTranscriptStats(transcript),
      } satisfies QaCharacterEvalRun;
    } catch (error) {
      const transcript = "";
      return {
        model,
        status: "fail",
        durationMs: Date.now() - runStartedAt,
        outputDir: modelOutputDir,
        thinkingDefault,
        fastMode,
        transcript,
        stats: collectTranscriptStats(transcript),
        error: formatErrorMessage(error),
      } satisfies QaCharacterEvalRun;
    }
  });

  const judgeModels = normalizeModelRefs(
    params.judgeModels && params.judgeModels.length > 0
      ? params.judgeModels
      : params.judgeModel
        ? [params.judgeModel]
        : DEFAULT_JUDGE_MODELS,
  );
  const runJudge = params.runJudge ?? defaultRunJudge;
  const judgeConcurrency = normalizeConcurrency(
    params.judgeConcurrency,
    DEFAULT_CHARACTER_EVAL_CONCURRENCY,
  );
  const judgments = await mapWithConcurrency(judgeModels, judgeConcurrency, async (judgeModel) => {
    const judgeOptions = resolveJudgeOptions({
      model: judgeModel,
      judgeThinkingDefault: params.judgeThinkingDefault,
      judgeModelOptions: params.judgeModelOptions,
    });
    let rankings: QaCharacterEvalJudgment[] = [];
    let judgeError: string | undefined;
    const judgeStartedAt = Date.now();
    try {
      const rawReply = await runJudge({
        repoRoot,
        judgeModel,
        judgeThinkingDefault: judgeOptions.thinkingDefault,
        judgeFastMode: judgeOptions.fastMode,
        prompt: buildJudgePrompt({ scenarioId, runs }),
        timeoutMs: params.judgeTimeoutMs ?? 180_000,
      });
      rankings = parseJudgeReply(rawReply, new Set(models));
    } catch (error) {
      judgeError = formatErrorMessage(error);
    }

    return {
      model: judgeModel,
      thinkingDefault: judgeOptions.thinkingDefault,
      fastMode: judgeOptions.fastMode,
      durationMs: Date.now() - judgeStartedAt,
      rankings,
      ...(judgeError ? { error: judgeError } : {}),
    } satisfies QaCharacterEvalJudgeResult;
  });

  const finishedAt = new Date();
  const report = renderCharacterEvalReport({
    scenarioId,
    startedAt,
    finishedAt,
    runs,
    judgments,
  });
  const reportPath = path.join(outputDir, "character-eval-report.md");
  const summaryPath = path.join(outputDir, "character-eval-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        scenarioId,
        runs,
        judgments,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    outputDir,
    reportPath,
    summaryPath,
    runs,
    judgments,
  } satisfies QaCharacterEvalResult;
}
