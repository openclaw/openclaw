import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBookWriterConfig } from "./config.js";
import { writeJsonFile } from "./files.js";
import { persistBenchRecord } from "./model-governor.js";
import { buildApprovedBacklog, runOvernightBookWriter } from "./overnight.js";
import type { BookBible, GateReport, ModelBenchRecord, ReviewPack } from "./types.js";

async function tempOutputDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-writer-overnight-"));
}

function passReport(): GateReport {
  return { status: "pass", findings: [] };
}

function measuredRecord(): ModelBenchRecord {
  return {
    provider: "ollama",
    model: "qwen2.5:32b",
    source: "measured",
    peakMemoryGb: 24,
    tokensPerSecond: 24,
    stableContextTokens: 32768,
    crashRate: 0,
    qualityScore: 0.79,
    measuredAt: "2026-05-18T00:00:00.000Z",
    notes: ["test measured record"],
  };
}

async function writeReviewPack(params: {
  outputDir: string;
  runId: string;
  recommendation?: ReviewPack["recommendation"];
  words?: number;
  kdpReady?: boolean;
}): Promise<ReviewPack> {
  const runDir = path.join(params.outputDir, params.runId);
  await fs.mkdir(runDir, { recursive: true });
  const bible: BookBible = {
    runId: params.runId,
    title: `Book ${params.runId}`,
    subtitle: "An Original Test",
    slug: params.runId,
    penName: "Northstar House",
    genre: "clean mystery",
    readerPromise: "A complete original test book.",
    premise: "A test premise.",
    cast: [],
    originalityStrategy: [],
    bannedDependencies: [],
    targetWords: params.words ?? 12000,
    createdAt: "2026-05-18T00:00:00.000Z",
  };
  const quality: GateReport = {
    status: "pass",
    findings: [
      {
        code: "word-count",
        status: "pass",
        score: params.words ?? 12000,
        message: "Word count passed.",
      },
    ],
  };
  const review: ReviewPack = {
    runId: params.runId,
    recommendation: params.recommendation ?? "approve",
    artifacts: {
      bookBible: path.join(runDir, "book-bible.json"),
      manuscript: path.join(runDir, "manuscript.md"),
      ebook: path.join(runDir, "ebook.epub"),
      cover: path.join(runDir, "cover.tiff"),
    },
    gaps: [],
    reports: {
      quality,
      originality: passReport(),
      editorialPolicy: passReport(),
      continuity: passReport(),
      storyQuality: passReport(),
      endurance: passReport(),
      exportValidation: passReport(),
    },
    publishPreview: {
      channel: "kdp",
      finalSubmitRequiresApproval: true,
      aiDisclosure: "Disclose AI-generated content as required.",
      kdpSelectDefault: true,
      title: `Book ${params.runId}`,
      subtitle: "An Original Test",
      description: "A test description.",
      keywords: ["clean mystery"],
      categories: ["Fiction / Mystery & Detective / Traditional"],
      pricing: { ebookUsd: 4.99 },
      checklist: ["Pause before final submit."],
    },
    createdAt: `2026-05-18T00:0${params.runId.endsWith("b") ? "2" : "1"}:00.000Z`,
  };
  await writeJsonFile(path.join(runDir, "book-bible.json"), bible);
  await fs.writeFile(
    path.join(runDir, "manuscript.md"),
    "word ".repeat(params.words ?? 12000),
    "utf8",
  );
  await writeJsonFile(path.join(runDir, "review-pack.json"), review);
  if (params.kdpReady) {
    await writeJsonFile(path.join(runDir, "kdp-dry-run-report.json"), {
      runId: params.runId,
      status: "ready",
      coverStrategy: "upload",
      findings: [],
      uploadManifestPath: path.join(runDir, "kdp-upload-manifest.json"),
      browserActionsPath: path.join(runDir, "kdp-browser-actions.json"),
      uploadManifest: {
        channel: "kdp",
        mode: "browser-assisted-dry-run",
        runId: params.runId,
        preparedAt: "2026-05-18T00:00:00.000Z",
        status: "ready",
        finalSubmitRequiresApproval: true,
        coverStrategy: "upload",
        files: {},
      },
      browserActions: [],
      finalSubmit: {
        allowed: false,
        requiresApproval: true,
        reason: "approval-gated",
      },
      createdAt: "2026-05-18T00:00:00.000Z",
    });
  }
  return review;
}

describe("book-writer overnight runner", () => {
  it("builds an approved backlog sorted by readiness and score", async () => {
    const outputDir = await tempOutputDir();
    await writeReviewPack({ outputDir, runId: "run-a", words: 11000 });
    await writeReviewPack({ outputDir, runId: "run-b", words: 13000, kdpReady: true });
    await writeReviewPack({ outputDir, runId: "run-blocked", recommendation: "blocked" });

    const backlog = await buildApprovedBacklog(outputDir, new Date("2026-05-18T00:00:00.000Z"));

    expect(backlog.entries.map((entry) => entry.runId)).toEqual(["run-b", "run-a"]);
    expect(backlog.selected?.runId).toBe("run-b");
    expect(backlog.selected?.kdpStatus).toBe("ready");
  });

  it("skips when no measured model is eligible by default", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const report = await runOvernightBookWriter({
      config,
      request: { targetWords: 12000 },
      dryRun: true,
      preparePublish: false,
    });

    expect(report.status).toBe("skipped");
    expect(report.gaps.join(" ")).toContain("No eligible measured local model");
  });

  it("uses a measured model for dry-run backlog selection", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    await persistBenchRecord(outputDir, measuredRecord());
    await writeReviewPack({ outputDir, runId: "approved-run", kdpReady: true });

    const report = await runOvernightBookWriter({
      config,
      request: { model: "qwen2.5:32b", targetWords: 12000 },
      dryRun: true,
      preparePublish: false,
      now: new Date("2026-05-18T01:00:00-04:00"),
    });

    expect(report.status).toBe("completed");
    expect(report.selectedModel?.source).toBe("measured");
    expect(report.backlog.selected?.runId).toBe("approved-run");
    await expect(fs.stat(path.join(outputDir, "approved-backlog.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outputDir, "overnight-run-report.json"))).resolves.toBeTruthy();
  });
});
