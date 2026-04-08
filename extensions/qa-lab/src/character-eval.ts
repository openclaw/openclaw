import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runQaManualLane } from "./manual-lane.runtime.js";
import { type QaProviderMode } from "./model-selection.js";
import { type QaThinkingLevel } from "./qa-gateway-config.js";
import { runQaSuite, type QaSuiteResult } from "./suite.js";

const DEFAULT_CHARACTER_SCENARIO_ID = "character-vibes-gollum";
const DEFAULT_CHARACTER_EVAL_MODELS = Object.freeze([
  "openai/gpt-5.4",
  "anthropic/claude-opus-4-6",
]);
const DEFAULT_JUDGE_MODEL = "openai/gpt-5.4";
const DEFAULT_JUDGE_THINKING: QaThinkingLevel = "xhigh";

type QaCharacterRunStatus = "pass" | "fail";

export type QaCharacterEvalRun = {
  model: string;
  status: QaCharacterRunStatus;
  durationMs: number;
  outputDir: string;
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
  judgment: {
    model: string;
    thinkingDefault: QaThinkingLevel;
    fastMode: boolean;
    rankings: QaCharacterEvalJudgment[];
    error?: string;
  };
};

type RunSuiteFn = (params: {
  repoRoot: string;
  outputDir: string;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  scenarioIds: string[];
}) => Promise<QaSuiteResult>;

type RunJudgeFn = (params: {
  repoRoot: string;
  judgeModel: string;
  judgeThinkingDefault: QaThinkingLevel;
  prompt: string;
  timeoutMs: number;
}) => Promise<string | null>;

export type QaCharacterEvalParams = {
  repoRoot?: string;
  outputDir?: string;
  models: string[];
  scenarioId?: string;
  candidateFastMode?: boolean;
  judgeModel?: string;
  judgeThinkingDefault?: QaThinkingLevel;
  judgeTimeoutMs?: number;
  runSuite?: RunSuiteFn;
  runJudge?: RunJudgeFn;
};

function normalizeModelRefs(models: readonly string[]) {
  return [...new Set(models.map((model) => model.trim()).filter((model) => model.length > 0))];
}

function sanitizePathPart(value: string) {
  const sanitized = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return sanitized || "model";
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

function buildJudgePrompt(params: { scenarioId: string; runs: readonly QaCharacterEvalRun[] }) {
  const runBlocks = params.runs
    .map(
      (run) => `## MODEL ${run.model}

Status: ${run.status}
Duration ms: ${run.durationMs}
Transcript chars: ${run.stats.transcriptChars}
Assistant turns: ${run.stats.assistantTurns}
Error: ${run.error ?? "none"}

\`\`\`text
${run.transcript}
\`\`\``,
    )
    .join("\n\n");

  return `You are grading OpenClaw character QA transcripts for naturalness, vibes, and funniness.

Scenario id: ${params.scenarioId}

Rank the models by:
- natural conversational reaction
- playful character commitment
- funny, surprising details
- coherence across turns
- avoiding tool/backend/error leakage

Treat model names as opaque labels. Do not assume quality from the label.

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
  prompt: string;
  timeoutMs: number;
}) {
  const result = await runQaManualLane({
    repoRoot: params.repoRoot,
    providerMode: "live-frontier",
    primaryModel: params.judgeModel,
    alternateModel: params.judgeModel,
    fastMode: true,
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
  judgment: QaCharacterEvalResult["judgment"];
}) {
  const lines = [
    "# OpenClaw Character Eval Report",
    "",
    `- Started: ${params.startedAt.toISOString()}`,
    `- Finished: ${params.finishedAt.toISOString()}`,
    `- Duration ms: ${params.finishedAt.getTime() - params.startedAt.getTime()}`,
    `- Scenario: ${params.scenarioId}`,
    "- Execution: local QA gateway child processes, not Docker",
    `- Judge: ${params.judgment.model}`,
    `- Judge thinking: ${params.judgment.thinkingDefault}`,
    `- Judge fast mode: ${params.judgment.fastMode ? "on" : "off"}`,
    "",
    "## Judge Ranking",
    "",
  ];

  if (params.judgment.rankings.length > 0) {
    for (const ranking of params.judgment.rankings) {
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
    if (params.judgment.error) {
      lines.push(`- Judge error: ${params.judgment.error}`);
    }
  }

  lines.push("", "## Run Stats", "");
  lines.push("| Model | Status | Duration ms | User turns | Assistant turns | Transcript chars |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const run of params.runs) {
    lines.push(
      `| ${run.model} | ${run.status} | ${run.durationMs} | ${run.stats.userTurns} | ${run.stats.assistantTurns} | ${run.stats.transcriptChars} |`,
    );
  }

  lines.push("", "## Transcripts", "");
  for (const run of params.runs) {
    lines.push(`### ${run.model}`, "");
    lines.push(`- Status: ${run.status}`);
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
  const runs: QaCharacterEvalRun[] = [];
  for (const model of models) {
    const modelOutputDir = path.join(runsDir, sanitizePathPart(model));
    const runStartedAt = Date.now();
    try {
      const result = await runSuite({
        repoRoot,
        outputDir: modelOutputDir,
        providerMode: "live-frontier",
        primaryModel: model,
        alternateModel: model,
        fastMode: params.candidateFastMode,
        scenarioIds: [scenarioId],
      });
      const transcript = extractTranscript(result);
      const status = result.scenarios.some((scenario) => scenario.status === "fail")
        ? "fail"
        : "pass";
      runs.push({
        model,
        status,
        durationMs: Date.now() - runStartedAt,
        outputDir: modelOutputDir,
        reportPath: result.reportPath,
        summaryPath: result.summaryPath,
        transcript,
        stats: collectTranscriptStats(transcript),
      });
    } catch (error) {
      const transcript = "";
      runs.push({
        model,
        status: "fail",
        durationMs: Date.now() - runStartedAt,
        outputDir: modelOutputDir,
        transcript,
        stats: collectTranscriptStats(transcript),
        error: formatErrorMessage(error),
      });
    }
  }

  const judgeModel = params.judgeModel?.trim() || DEFAULT_JUDGE_MODEL;
  const judgeThinkingDefault = params.judgeThinkingDefault ?? DEFAULT_JUDGE_THINKING;
  const runJudge = params.runJudge ?? defaultRunJudge;
  let rawReply: string | null = null;
  let rankings: QaCharacterEvalJudgment[] = [];
  let judgeError: string | undefined;
  try {
    rawReply = await runJudge({
      repoRoot,
      judgeModel,
      judgeThinkingDefault,
      prompt: buildJudgePrompt({ scenarioId, runs }),
      timeoutMs: params.judgeTimeoutMs ?? 180_000,
    });
    rankings = parseJudgeReply(rawReply, new Set(models));
  } catch (error) {
    judgeError = formatErrorMessage(error);
  }

  const finishedAt = new Date();
  const judgment = {
    model: judgeModel,
    thinkingDefault: judgeThinkingDefault,
    fastMode: true,
    rankings,
    ...(judgeError ? { error: judgeError } : {}),
  };
  const report = renderCharacterEvalReport({
    scenarioId,
    startedAt,
    finishedAt,
    runs,
    judgment,
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
        judgment,
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
    judgment,
  } satisfies QaCharacterEvalResult;
}
