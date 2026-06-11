import path from "node:path";
import { readJsonFile, writeJsonFile } from "./files.js";
import type { BookWriterMode, EnduranceEstimate, MemoryPolicy, ModelBenchRecord } from "./types.js";

export const DEFAULT_MODEL_CATALOG: ModelBenchRecord[] = [
  {
    provider: "lmstudio",
    model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    source: "estimated",
    peakMemoryGb: 52,
    tokensPerSecond: 24,
    stableContextTokens: 32768,
    crashRate: 0.02,
    qualityScore: 0.82,
    measuredAt: "estimated",
    notes: ["Default daily writer candidate; benchmark before approving live scheduling."],
  },
  {
    provider: "lmstudio",
    model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    source: "estimated",
    peakMemoryGb: 46,
    tokensPerSecond: 28,
    stableContextTokens: 32768,
    crashRate: 0.02,
    qualityScore: 0.78,
    measuredAt: "estimated",
    notes: ["Recommended prose editor and repetition cleanup model."],
  },
  {
    provider: "lmstudio",
    model: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    source: "estimated",
    peakMemoryGb: 92,
    tokensPerSecond: 10,
    stableContextTokens: 32768,
    crashRate: 0.04,
    qualityScore: 0.88,
    measuredAt: "estimated",
    notes: ["Premium planner only; requires measured fit under premium cap."],
  },
  {
    provider: "lmstudio",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    source: "estimated",
    peakMemoryGb: 88,
    tokensPerSecond: 11,
    stableContextTokens: 32768,
    crashRate: 0.04,
    qualityScore: 0.84,
    measuredAt: "estimated",
    notes: ["Premium quality pass candidate."],
  },
  {
    provider: "lmstudio",
    model: "gpt-oss-20b",
    source: "estimated",
    peakMemoryGb: 30,
    tokensPerSecond: 34,
    stableContextTokens: 32768,
    crashRate: 0.02,
    qualityScore: 0.72,
    measuredAt: "estimated",
    notes: ["Cheap classification and QA helper."],
  },
  {
    provider: "lmstudio",
    model: "gpt-oss-120b",
    source: "estimated",
    peakMemoryGb: 124,
    tokensPerSecond: 6,
    stableContextTokens: 32768,
    crashRate: 0.08,
    qualityScore: 0.9,
    measuredAt: "estimated",
    notes: ["Too large for daily book-writing on this multitask schedule."],
  },
];

export function memoryCapForMode(policy: MemoryPolicy, mode: BookWriterMode): number {
  if (mode === "premium") {
    return policy.premiumGb;
  }
  if (mode === "ideal") {
    return policy.idealGb;
  }
  if (mode === "light") {
    return Math.min(48, policy.defaultGb);
  }
  return policy.defaultGb;
}

export function evaluateModelEligibility(params: {
  record: ModelBenchRecord;
  policy: MemoryPolicy;
  mode: BookWriterMode;
}): { eligible: boolean; capGb: number; reasons: string[] } {
  const capGb = memoryCapForMode(params.policy, params.mode);
  const reasons: string[] = [];
  if (params.record.peakMemoryGb > params.policy.hardRejectGb) {
    reasons.push(
      `peak memory ${params.record.peakMemoryGb} GB exceeds hard reject cap ${params.policy.hardRejectGb} GB`,
    );
  }
  if (params.record.peakMemoryGb > capGb) {
    reasons.push(
      `peak memory ${params.record.peakMemoryGb} GB exceeds ${params.mode} cap ${capGb} GB`,
    );
  }
  if (params.record.crashRate > 0.15) {
    reasons.push(`crash rate ${params.record.crashRate} exceeds 0.15`);
  }
  if (params.record.tokensPerSecond <= 0) {
    reasons.push("tokens/sec must be positive");
  }
  return {
    eligible: reasons.length === 0,
    capGb,
    reasons,
  };
}

export function selectBestModel(params: {
  records: ModelBenchRecord[];
  policy: MemoryPolicy;
  mode: BookWriterMode;
  preferredModel?: string;
}): { selected?: ModelBenchRecord; rejected: Array<{ model: string; reasons: string[] }> } {
  const records = params.preferredModel
    ? params.records.filter((record) => record.model === params.preferredModel)
    : params.records;
  const rejected: Array<{ model: string; reasons: string[] }> = [];
  const eligible = records.filter((record) => {
    const evaluation = evaluateModelEligibility({
      record,
      policy: params.policy,
      mode: params.mode,
    });
    if (!evaluation.eligible) {
      rejected.push({ model: record.model, reasons: evaluation.reasons });
    }
    return evaluation.eligible;
  });
  eligible.sort(
    (left, right) =>
      right.qualityScore - left.qualityScore ||
      right.tokensPerSecond - left.tokensPerSecond ||
      left.peakMemoryGb - right.peakMemoryGb,
  );
  return { selected: eligible[0], rejected };
}

export async function readBenchRecords(outputDir: string): Promise<ModelBenchRecord[]> {
  const benchPath = path.join(outputDir, "model-bench.json");
  const stored = await readJsonFile<ModelBenchRecord[]>(benchPath);
  if (!stored) {
    return DEFAULT_MODEL_CATALOG;
  }
  const byModel = new Map(DEFAULT_MODEL_CATALOG.map((record) => [record.model, record]));
  for (const record of stored) {
    byModel.set(record.model, record);
  }
  return Array.from(byModel.values());
}

export async function persistBenchRecord(
  outputDir: string,
  record: ModelBenchRecord,
): Promise<ModelBenchRecord[]> {
  const current = await readBenchRecords(outputDir);
  const next = new Map(current.map((item) => [item.model, item]));
  next.set(record.model, record);
  const records = Array.from(next.values());
  await writeJsonFile(path.join(outputDir, "model-bench.json"), records);
  return records;
}

export function estimateSchedule(params: {
  targetWords: number;
  tokensPerSecond: number;
  reviewReadyBy: string;
  now?: Date;
}): {
  estimatedMinutes: number;
  canFinishByReviewTime: boolean;
  reviewReadyBy: string;
} {
  const tokens = Math.ceil(params.targetWords * 1.45 * 2.4);
  const seconds = tokens / Math.max(1, params.tokensPerSecond);
  const estimatedMinutes = Math.ceil(seconds / 60 + 90);
  const now = params.now ?? new Date();
  const [hourText, minuteText] = params.reviewReadyBy.split(":");
  const due = new Date(now);
  due.setHours(Number(hourText ?? "7"), Number(minuteText ?? "0"), 0, 0);
  if (due <= now) {
    due.setDate(due.getDate() + 1);
  }
  const availableMinutes = Math.floor((due.getTime() - now.getTime()) / 60000);
  return {
    estimatedMinutes,
    canFinishByReviewTime: estimatedMinutes <= availableMinutes,
    reviewReadyBy: due.toISOString(),
  };
}

export function estimateBookEndurance(params: {
  targetWords: number;
  chapterCount: number;
  tokensPerSecond: number;
  reviewReadyBy: string;
  now?: Date;
  maxAttemptsPerChapter?: number;
  overheadMinutes?: number;
}): EnduranceEstimate {
  const maxAttemptsPerChapter = params.maxAttemptsPerChapter ?? 2;
  const overheadMinutes = params.overheadMinutes ?? 140;
  const outputTokens = Math.ceil(params.targetWords * 1.45);
  const retryReserveTokens = Math.ceil(outputTokens * 0.35);
  const promptAndJudgeTokens = params.chapterCount * maxAttemptsPerChapter * 900;
  const requiredTokensEstimate = outputTokens + retryReserveTokens + promptAndJudgeTokens;
  const seconds = requiredTokensEstimate / Math.max(1, params.tokensPerSecond);
  const estimatedMinutes = Math.ceil(seconds / 60 + overheadMinutes);
  const now = params.now ?? new Date();
  const [hourText, minuteText] = params.reviewReadyBy.split(":");
  const due = new Date(now);
  due.setHours(Number(hourText ?? "7"), Number(minuteText ?? "0"), 0, 0);
  if (due <= now) {
    due.setDate(due.getDate() + 1);
  }
  const availableMinutes = Math.floor((due.getTime() - now.getTime()) / 60000);
  return {
    targetWords: params.targetWords,
    chapterCount: params.chapterCount,
    maxAttemptsPerChapter,
    estimatedMinutes,
    canFinishByReviewTime: estimatedMinutes <= availableMinutes,
    reviewReadyBy: due.toISOString(),
    requiredTokensEstimate,
    overheadMinutes,
  };
}
