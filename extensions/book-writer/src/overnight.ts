import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedBookWriterConfig } from "./config.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { prepareKdpDryRun } from "./kdp-dry-run.js";
import {
  estimateBookEndurance,
  evaluateModelEligibility,
  readBenchRecords,
  selectBestModel,
} from "./model-governor.js";
import { runBookWriterPipeline } from "./pipeline.js";
import { countWords } from "./text.js";
import type {
  BookWriterMode,
  BookWriterRequest,
  EnduranceEstimate,
  GateReport,
  KdpDryRunReport,
  ModelBenchRecord,
  ReviewPack,
} from "./types.js";

export type ApprovedBacklogEntry = {
  runId: string;
  title: string;
  penName?: string;
  createdAt: string;
  score: number;
  wordCount: number;
  priceUsd?: number;
  kdpStatus?: KdpDryRunReport["status"];
  artifacts: Record<string, string>;
};

export type ApprovedBacklog = {
  generatedAt: string;
  entries: ApprovedBacklogEntry[];
  selected?: ApprovedBacklogEntry;
};

export type OvernightRunOptions = {
  config: ResolvedBookWriterConfig;
  request: BookWriterRequest;
  mode?: BookWriterMode;
  allowEstimated?: boolean;
  force?: boolean;
  dryRun?: boolean;
  preparePublish?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
};

export type OvernightRunReport = {
  status: "completed" | "skipped" | "failed";
  runId?: string;
  selectedModel?: ModelBenchRecord;
  eligibility?: ReturnType<typeof evaluateModelEligibility>;
  endurance?: EnduranceEstimate;
  reviewPack?: ReviewPack;
  backlog: ApprovedBacklog;
  publishDryRun?: KdpDryRunReport;
  gaps: string[];
  createdAt: string;
};

function reportStatus(report: GateReport | undefined): number {
  if (!report) {
    return 0;
  }
  if (report.status === "pass") {
    return 16;
  }
  if (report.status === "warn") {
    return 6;
  }
  return -60;
}

function findingScore(report: GateReport | undefined, code: string): number | undefined {
  return report?.findings.find((finding) => finding.code === code)?.score;
}

async function manuscriptWordCount(review: ReviewPack): Promise<number> {
  const fromReport = findingScore(review.reports.quality, "word-count");
  if (typeof fromReport === "number") {
    return fromReport;
  }
  const manuscriptPath = review.artifacts.manuscript;
  if (!manuscriptPath) {
    return 0;
  }
  try {
    return countWords(await fs.readFile(manuscriptPath, "utf8"));
  } catch {
    return 0;
  }
}

function scoreReviewPack(review: ReviewPack, wordCount: number, kdpStatus?: string): number {
  const base = 100;
  const gateScore =
    reportStatus(review.reports.quality) +
    reportStatus(review.reports.originality) +
    reportStatus(review.reports.editorialPolicy) +
    reportStatus(review.reports.continuity) +
    reportStatus(review.reports.storyQuality) +
    reportStatus(review.reports.endurance) +
    reportStatus(review.reports.exportValidation);
  const priceScore = Math.round((review.publishPreview.pricing.ebookUsd ?? 2.99) * 3);
  const lengthScore = Math.min(28, Math.floor(wordCount / 2500));
  const kdpScore = kdpStatus === "ready" ? 18 : kdpStatus === "needs-review" ? 4 : 0;
  return base + gateScore + priceScore + lengthScore + kdpScore;
}

export async function buildApprovedBacklog(
  outputDir: string,
  now = new Date(),
): Promise<ApprovedBacklog> {
  const entries: ApprovedBacklogEntry[] = [];
  let dirents: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    dirents = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { generatedAt: now.toISOString(), entries: [] };
    }
    throw error;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const runDir = path.join(outputDir, dirent.name);
    const review = await readJsonFile<ReviewPack>(path.join(runDir, "review-pack.json"));
    if (!review || review.recommendation !== "approve") {
      continue;
    }
    const bible = await readJsonFile<{ penName?: string }>(
      review.artifacts.bookBible ?? path.join(runDir, "book-bible.json"),
    );
    const dryRun = await readJsonFile<KdpDryRunReport>(
      path.join(runDir, "kdp-dry-run-report.json"),
    );
    const wordCount = await manuscriptWordCount(review);
    entries.push({
      runId: review.runId,
      title: review.publishPreview.title,
      penName: bible?.penName,
      createdAt: review.createdAt,
      score: scoreReviewPack(review, wordCount, dryRun?.status),
      wordCount,
      priceUsd: review.publishPreview.pricing.ebookUsd,
      kdpStatus: dryRun?.status,
      artifacts: review.artifacts,
    });
  }

  entries.sort(
    (left, right) =>
      right.score - left.score ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      left.runId.localeCompare(right.runId),
  );
  return {
    generatedAt: now.toISOString(),
    entries,
    selected: entries[0],
  };
}

async function persistBacklog(outputDir: string, backlog: ApprovedBacklog): Promise<void> {
  await writeJsonFile(path.join(outputDir, "approved-backlog.json"), backlog);
}

function selectedRecords(params: {
  records: ModelBenchRecord[];
  allowEstimated?: boolean;
  preferredModel?: string;
}): ModelBenchRecord[] {
  const sourceFiltered = params.allowEstimated
    ? params.records.filter((record) => record.source !== "unavailable")
    : params.records.filter((record) => record.source === "measured");
  if (!params.preferredModel) {
    return sourceFiltered;
  }
  return sourceFiltered.filter((record) => record.model === params.preferredModel);
}

export async function runOvernightBookWriter(
  options: OvernightRunOptions,
): Promise<OvernightRunReport> {
  const mode = options.mode ?? options.request.mode ?? "normal";
  const now = options.now ?? new Date();
  const gaps: string[] = [];
  const records = await readBenchRecords(options.config.outputDir);
  const eligibleSourceRecords = selectedRecords({
    records,
    allowEstimated: options.allowEstimated,
    preferredModel: options.request.model,
  });
  const selection = selectBestModel({
    records: eligibleSourceRecords,
    policy: options.config.memoryPolicy,
    mode,
    preferredModel: options.request.model,
  });
  const selected = selection.selected;
  const backlogBefore = await buildApprovedBacklog(options.config.outputDir, now);

  if (!selected) {
    gaps.push(
      options.allowEstimated
        ? "No eligible local model was available for the overnight run."
        : "No eligible measured local model was available; run model-bench --live or pass --allow-estimated.",
    );
    const report: OvernightRunReport = {
      status: "skipped",
      backlog: backlogBefore,
      gaps,
      createdAt: now.toISOString(),
    };
    await persistBacklog(options.config.outputDir, backlogBefore);
    await writeJsonFile(path.join(options.config.outputDir, "overnight-run-report.json"), report);
    return report;
  }

  const eligibility = evaluateModelEligibility({
    record: selected,
    policy: options.config.memoryPolicy,
    mode,
  });
  const targetWords = options.request.targetWords ?? 12000;
  const endurance = estimateBookEndurance({
    targetWords,
    chapterCount: 8,
    tokensPerSecond: selected.tokensPerSecond,
    reviewReadyBy: options.config.schedule.reviewReadyBy,
    now,
  });

  if (!eligibility.eligible) {
    gaps.push(...eligibility.reasons);
  }
  if (!endurance.canFinishByReviewTime) {
    gaps.push(
      `Estimated run is ${endurance.estimatedMinutes} minutes and misses ${options.config.schedule.reviewReadyBy}.`,
    );
  }
  if (gaps.length > 0 && !options.force) {
    const report: OvernightRunReport = {
      status: "skipped",
      selectedModel: selected,
      eligibility,
      endurance,
      backlog: backlogBefore,
      gaps,
      createdAt: now.toISOString(),
    };
    await persistBacklog(options.config.outputDir, backlogBefore);
    await writeJsonFile(path.join(options.config.outputDir, "overnight-run-report.json"), report);
    return report;
  }

  let reviewPack: ReviewPack | undefined;
  if (!options.dryRun) {
    reviewPack = await runBookWriterPipeline({
      config: options.config,
      request: {
        ...options.request,
        mode,
        model: selected.model,
        liveModel: options.request.liveModel ?? true,
      },
      stages: "review-pack",
      fetchImpl: options.fetchImpl,
    });
  }

  const backlog = await buildApprovedBacklog(options.config.outputDir, new Date());
  let publishDryRun: KdpDryRunReport | undefined;
  if (options.preparePublish !== false && backlog.selected) {
    publishDryRun = await prepareKdpDryRun({
      outputDir: options.config.outputDir,
      runId: backlog.selected.runId,
    });
  }
  const refreshedBacklog =
    publishDryRun && backlog.selected
      ? await buildApprovedBacklog(options.config.outputDir, new Date())
      : backlog;
  await persistBacklog(options.config.outputDir, refreshedBacklog);

  const report: OvernightRunReport = {
    status: "completed",
    runId: reviewPack?.runId ?? refreshedBacklog.selected?.runId,
    selectedModel: selected,
    eligibility,
    endurance,
    reviewPack,
    backlog: refreshedBacklog,
    publishDryRun,
    gaps: reviewPack?.gaps ?? [],
    createdAt: new Date().toISOString(),
  };
  await writeJsonFile(path.join(options.config.outputDir, "overnight-run-report.json"), report);
  if (reviewPack?.runId) {
    await writeJsonFile(
      path.join(options.config.outputDir, reviewPack.runId, "overnight-run-report.json"),
      report,
    );
  }
  return report;
}
