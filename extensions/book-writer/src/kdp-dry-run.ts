import path from "node:path";
import { isKdpReadyTiffCover, readTiffCoverInfoFromFile } from "./cover.js";
import { fileExists, readJsonFile, resolveRunPaths, writeJsonFile } from "./files.js";
import type {
  GateFinding,
  GateStatus,
  KdpBrowserAction,
  KdpCoverStrategy,
  KdpDryRunReport,
  KdpDryRunStatus,
  KdpUploadManifest,
  ReviewPack,
} from "./types.js";

export type PrepareKdpDryRunOptions = {
  outputDir: string;
  runId: string;
  allowRevise?: boolean;
  coverStrategy?: KdpCoverStrategy;
};

const KDP_BOOKSHELF_URL = "https://kdp.amazon.com/en_US/bookshelf";

export function normalizeKdpCoverStrategy(value?: string): KdpCoverStrategy | undefined {
  if (value === "upload" || value === "kdp-cover-creator") {
    return value;
  }
  return undefined;
}

export function isKdpEbookCoverUploadFile(filePath?: string): boolean {
  return /\.(jpe?g|tiff?)$/i.test(filePath ?? "");
}

async function isKdpCoverUploadReady(filePath?: string): Promise<boolean> {
  if (!filePath || !(await fileExists(filePath)) || !isKdpEbookCoverUploadFile(filePath)) {
    return false;
  }
  if (/\.tiff?$/i.test(filePath)) {
    return isKdpReadyTiffCover(await readTiffCoverInfoFromFile(filePath));
  }
  return true;
}

function finding(code: string, status: GateStatus, message: string): GateFinding {
  return { code, status, message };
}

async function artifactExists(filePath?: string): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  return fileExists(filePath);
}

function dryRunStatus(findings: GateFinding[]): KdpDryRunStatus {
  if (findings.some((item) => item.status === "blocked" || item.status === "fail")) {
    return "blocked";
  }
  if (findings.some((item) => item.status === "warn")) {
    return "needs-review";
  }
  return "ready";
}

function browserActions(params: {
  review?: ReviewPack;
  coverStrategy: KdpCoverStrategy;
  coverUploadReady: boolean;
}): KdpBrowserAction[] {
  const preview = params.review?.publishPreview;
  const artifacts = params.review?.artifacts ?? {};
  const actions: KdpBrowserAction[] = [
    {
      id: "open-kdp-bookshelf",
      kind: "navigate",
      target: KDP_BOOKSHELF_URL,
      note: "Sign in and start a new Kindle eBook from the KDP Bookshelf.",
    },
    {
      id: "create-kindle-ebook",
      kind: "click",
      target: "Create > Kindle eBook",
    },
  ];

  if (preview) {
    actions.push(
      { id: "fill-title", kind: "fill", target: "Book title", value: preview.title },
      { id: "fill-subtitle", kind: "fill", target: "Subtitle", value: preview.subtitle },
      { id: "fill-description", kind: "fill", target: "Description", value: preview.description },
      { id: "fill-keywords", kind: "fill", target: "Keywords", value: preview.keywords },
      { id: "choose-categories", kind: "select", target: "Categories", value: preview.categories },
      {
        id: "set-ai-disclosure",
        kind: "confirm",
        target: "AI-generated content disclosure",
        value: preview.aiDisclosure,
        note: "Operator must confirm the final KDP disclosure based on the actual production process.",
      },
      {
        id: "confirm-original-rights",
        kind: "confirm",
        target: "Publishing rights",
        value: "I own the copyright and hold necessary publishing rights.",
      },
    );
  }

  if (artifacts.ebook) {
    actions.push({
      id: "upload-ebook",
      kind: "upload",
      target: "Manuscript",
      file: artifacts.ebook,
    });
  }

  if (params.coverStrategy === "upload" && artifacts.cover && params.coverUploadReady) {
    actions.push({
      id: "upload-cover",
      kind: "upload",
      target: "eBook cover image",
      file: artifacts.cover,
    });
  } else {
    actions.push({
      id: "launch-cover-creator",
      kind: "click",
      target: "Launch Cover Creator",
      file: artifacts.coverBrief,
      note: "Use the cover brief and book metadata; the generated SVG placeholder is not a direct KDP eBook cover upload file.",
    });
  }

  actions.push(
    {
      id: "open-previewer",
      kind: "click",
      target: "Launch Previewer",
      note: "Verify the uploaded EPUB and cover preview before continuing.",
    },
    {
      id: "set-kdp-select",
      kind: "confirm",
      target: "KDP Select enrollment",
      value: preview?.kdpSelectDefault ?? true,
      note: "Confirm exclusivity before enrolling the eBook in KDP Select.",
    },
    {
      id: "set-ebook-price",
      kind: "fill",
      target: "Kindle eBook list price",
      value: preview?.pricing.ebookUsd ?? 2.99,
    },
    {
      id: "stop-before-final-submit",
      kind: "pause",
      target: "Publish Your Kindle eBook",
      requiresApproval: true,
      note: "Dry-run stops here. Final submit is disabled unless an approval-gated publishing adapter is explicitly configured.",
    },
  );

  return actions;
}

export async function prepareKdpDryRun(options: PrepareKdpDryRunOptions): Promise<KdpDryRunReport> {
  const paths = resolveRunPaths(options.outputDir, options.runId);
  const runDir = paths.runDir;
  const reviewPath = path.join(runDir, "review-pack.json");
  const uploadManifestPath = path.join(runDir, "kdp-upload-manifest.json");
  const browserActionsPath = path.join(runDir, "kdp-browser-actions.json");
  const dryRunReportPath = path.join(runDir, "kdp-dry-run-report.json");
  const review = await readJsonFile<ReviewPack>(reviewPath);
  const artifacts = review?.artifacts ?? {};
  const coverUploadReady = await isKdpCoverUploadReady(artifacts.cover);
  const coverStrategy =
    options.coverStrategy ?? (coverUploadReady ? "upload" : "kdp-cover-creator");
  const findings: GateFinding[] = [];

  findings.push(
    review
      ? finding("review-pack-present", "pass", "Review pack is present.")
      : finding("review-pack-present", "blocked", "Missing review-pack.json."),
  );

  if (review?.recommendation === "approve") {
    findings.push(finding("review-pack-approved", "pass", "Review pack is approved."));
  } else if (review && options.allowRevise) {
    findings.push(
      finding(
        "review-pack-approved",
        "warn",
        `Review pack is ${review.recommendation}; --allow-revise permits a dry-run only.`,
      ),
    );
  } else {
    findings.push(
      finding(
        "review-pack-approved",
        "blocked",
        review
          ? `Review pack recommendation is ${review.recommendation}; publish prep requires approve.`
          : "Cannot verify review recommendation.",
      ),
    );
  }

  findings.push(
    (await artifactExists(artifacts.ebook))
      ? finding("ebook-artifact", "pass", "ebook.epub is available for upload.")
      : finding("ebook-artifact", "blocked", "Missing ebook.epub upload artifact."),
  );
  findings.push(
    (await artifactExists(artifacts.metadata))
      ? finding("metadata-artifact", "pass", "metadata.json is available.")
      : finding("metadata-artifact", "blocked", "Missing metadata.json."),
  );
  findings.push(
    (await artifactExists(artifacts.publishPreview))
      ? finding("publish-preview-artifact", "pass", "publish-preview.json is available.")
      : finding("publish-preview-artifact", "blocked", "Missing publish-preview.json."),
  );

  if (review?.reports.exportValidation.status === "pass") {
    findings.push(finding("export-validation", "pass", "EPUB and print export validation passed."));
  } else {
    findings.push(
      finding(
        "export-validation",
        "blocked",
        "Upload-grade dry-run requires a passing export-validation-report.json.",
      ),
    );
  }

  if (coverStrategy === "upload") {
    findings.push(
      coverUploadReady && (await artifactExists(artifacts.cover))
        ? finding("cover-upload", "pass", "Cover file is JPEG/TIFF and ready for KDP upload.")
        : finding(
            "cover-upload",
            "blocked",
            "KDP eBook cover upload requires an upload-ready JPEG or TIFF cover file; use Cover Creator or provide a technically valid cover.",
          ),
    );
  } else {
    findings.push(
      (await artifactExists(artifacts.coverBrief))
        ? finding(
            "cover-creator",
            "pass",
            "Cover Creator route is ready with cover brief and metadata.",
          )
        : finding(
            "cover-creator",
            "warn",
            "Cover Creator route selected but cover brief is missing.",
          ),
    );
  }

  findings.push(
    finding(
      "final-submit-approval",
      "pass",
      "Final KDP submit is intentionally blocked by this browser-assisted dry-run.",
    ),
  );

  const status = dryRunStatus(findings);
  const createdAt = new Date().toISOString();
  const uploadManifest: KdpUploadManifest = {
    channel: "kdp",
    mode: "browser-assisted-dry-run",
    runId: paths.runId,
    preparedAt: createdAt,
    status,
    finalSubmitRequiresApproval: true,
    coverStrategy,
    files: {
      ebook: artifacts.ebook,
      printPdf: artifacts.printPdf,
      coverUpload: coverStrategy === "upload" && coverUploadReady ? artifacts.cover : undefined,
      coverBrief: artifacts.coverBrief,
      metadata: artifacts.metadata,
      publishPreview: artifacts.publishPreview,
    },
    metadata: review?.publishPreview,
    aiDisclosure: review?.publishPreview.aiDisclosure,
    kdpSelectDefault: review?.publishPreview.kdpSelectDefault,
  };
  const actions = browserActions({ review, coverStrategy, coverUploadReady });
  const report: KdpDryRunReport = {
    runId: paths.runId,
    status,
    coverStrategy,
    findings,
    uploadManifestPath,
    browserActionsPath,
    uploadManifest,
    browserActions: actions,
    finalSubmit: {
      allowed: false,
      requiresApproval: true,
      reason: "KDP final submit remains approval-gated and is not executed by v1.",
    },
    createdAt,
  };

  await writeJsonFile(uploadManifestPath, uploadManifest);
  await writeJsonFile(browserActionsPath, actions);
  await writeJsonFile(dryRunReportPath, report);
  return report;
}
