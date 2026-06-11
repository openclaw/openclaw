import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCoverTiff } from "./cover.js";
import { writeJsonFile } from "./files.js";
import { prepareKdpDryRun } from "./kdp-dry-run.js";
import type { BookBible, ReviewPack } from "./types.js";

async function tempOutputDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-writer-kdp-"));
}

async function writeApprovedReviewPack(params: {
  outputDir: string;
  runId: string;
  recommendation?: ReviewPack["recommendation"];
  cover?: string;
  exportStatus?: ReviewPack["reports"]["exportValidation"]["status"];
}): Promise<ReviewPack> {
  const runDir = path.join(params.outputDir, params.runId);
  await fs.mkdir(runDir, { recursive: true });
  const artifacts = {
    ebook: path.join(runDir, "ebook.epub"),
    metadata: path.join(runDir, "metadata.json"),
    publishPreview: path.join(runDir, "publish-preview.json"),
    coverBrief: path.join(runDir, "cover-brief.json"),
    cover: params.cover ?? path.join(runDir, "cover.svg"),
    printPdf: path.join(runDir, "print.pdf"),
  };
  await fs.writeFile(artifacts.ebook, "epub", "utf8");
  await fs.writeFile(artifacts.metadata, "{}", "utf8");
  await fs.writeFile(artifacts.publishPreview, "{}", "utf8");
  await fs.writeFile(artifacts.coverBrief, "{}", "utf8");
  if (/\.tiff?$/i.test(artifacts.cover)) {
    await fs.writeFile(artifacts.cover, buildCoverTiff(fixtureBible()));
  } else {
    await fs.writeFile(artifacts.cover, "cover", "utf8");
  }
  await fs.writeFile(artifacts.printPdf, "%PDF-1.7", "utf8");
  const passReport = { status: "pass" as const, findings: [] };
  const review: ReviewPack = {
    runId: params.runId,
    recommendation: params.recommendation ?? "approve",
    artifacts,
    gaps: [],
    reports: {
      quality: passReport,
      originality: passReport,
      editorialPolicy: passReport,
      continuity: passReport,
      storyQuality: passReport,
      endurance: passReport,
      exportValidation: {
        status: params.exportStatus ?? "pass",
        findings: [],
      },
    },
    publishPreview: {
      channel: "kdp",
      finalSubmitRequiresApproval: true,
      aiDisclosure: "Disclose AI-generated text and cover if used.",
      kdpSelectDefault: true,
      title: "The Dry Run",
      subtitle: "An Original Test",
      description: "A clean original test description.",
      keywords: ["clean mystery", "original fiction"],
      categories: ["Fiction / Mystery & Detective / Traditional"],
      pricing: { ebookUsd: 2.99 },
      checklist: ["Pause before final submit."],
    },
    createdAt: "2026-05-18T00:00:00.000Z",
  };
  await writeJsonFile(path.join(runDir, "review-pack.json"), review);
  return review;
}

function fixtureBible(): BookBible {
  return {
    runId: "kdp-cover",
    title: "The Dry Run",
    subtitle: "An Original Test",
    slug: "the-dry-run",
    penName: "Northstar House",
    genre: "clean mystery",
    readerPromise: "A complete original test book.",
    premise: "A test premise.",
    cast: [],
    originalityStrategy: [],
    bannedDependencies: [],
    targetWords: 12000,
    createdAt: "2026-05-18T00:00:00.000Z",
  };
}

describe("KDP dry-run publishing prep", () => {
  it("creates a ready browser-assisted plan that pauses before final submit", async () => {
    const outputDir = await tempOutputDir();
    await writeApprovedReviewPack({ outputDir, runId: "ready-run" });

    const report = await prepareKdpDryRun({ outputDir, runId: "ready-run" });

    expect(report.status).toBe("ready");
    expect(report.finalSubmit.allowed).toBe(false);
    expect(report.finalSubmit.requiresApproval).toBe(true);
    expect(report.coverStrategy).toBe("kdp-cover-creator");
    expect(report.browserActions.map((action) => action.id)).toContain("upload-ebook");
    expect(report.browserActions.at(-1)?.id).toBe("stop-before-final-submit");
    await expect(
      fs.stat(path.join(outputDir, "ready-run", "kdp-upload-manifest.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, "ready-run", "kdp-browser-actions.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, "ready-run", "kdp-dry-run-report.json")),
    ).resolves.toBeTruthy();
  });

  it("auto-selects direct cover upload when a KDP-ready TIFF is present", async () => {
    const outputDir = await tempOutputDir();
    await writeApprovedReviewPack({
      outputDir,
      runId: "tiff-cover-run",
      cover: path.join(outputDir, "tiff-cover-run", "cover.tiff"),
    });

    const report = await prepareKdpDryRun({ outputDir, runId: "tiff-cover-run" });

    expect(report.status).toBe("ready");
    expect(report.coverStrategy).toBe("upload");
    expect(report.uploadManifest.files.coverUpload).toContain("cover.tiff");
    expect(report.browserActions.map((action) => action.id)).toContain("upload-cover");
  });

  it("blocks direct cover upload when the cover is not JPEG or TIFF", async () => {
    const outputDir = await tempOutputDir();
    await writeApprovedReviewPack({ outputDir, runId: "svg-cover-run" });

    const report = await prepareKdpDryRun({
      outputDir,
      runId: "svg-cover-run",
      coverStrategy: "upload",
    });

    expect(report.status).toBe("blocked");
    expect(report.findings.find((finding) => finding.code === "cover-upload")?.status).toBe(
      "blocked",
    );
  });

  it("blocks non-approved review packs unless revise dry-run is explicitly allowed", async () => {
    const outputDir = await tempOutputDir();
    await writeApprovedReviewPack({
      outputDir,
      runId: "revise-run",
      recommendation: "revise",
    });

    const blocked = await prepareKdpDryRun({ outputDir, runId: "revise-run" });
    const allowed = await prepareKdpDryRun({
      outputDir,
      runId: "revise-run",
      allowRevise: true,
    });

    expect(blocked.status).toBe("blocked");
    expect(allowed.status).toBe("needs-review");
    expect(
      allowed.findings.find((finding) => finding.code === "review-pack-approved")?.status,
    ).toBe("warn");
  });

  it("blocks missing upload-grade export validation", async () => {
    const outputDir = await tempOutputDir();
    await writeApprovedReviewPack({
      outputDir,
      runId: "export-warn-run",
      exportStatus: "warn",
    });

    const report = await prepareKdpDryRun({ outputDir, runId: "export-warn-run" });

    expect(report.status).toBe("blocked");
    expect(report.findings.find((finding) => finding.code === "export-validation")?.status).toBe(
      "blocked",
    );
  });
});
