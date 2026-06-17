// Qa Lab plugin module implements generic QA evidence gallery data.
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryEntry,
} from "./evidence-summary.js";

const TEXT_PREVIEW_BYTES = 12 * 1024;

type QaEvidenceArtifact = NonNullable<QaEvidenceSummaryEntry["execution"]>["artifacts"][number];

export type QaEvidenceArtifactView = {
  exists: boolean;
  error: string | null;
  href: string | null;
  kind: string;
  mediaKind: "image" | "video" | "json" | "text" | "file";
  path: string;
  preview: string | null;
  source: string;
};

export type QaEvidenceGalleryEntryView = {
  artifacts: QaEvidenceArtifactView[];
  coverage: QaEvidenceSummaryEntry["coverage"];
  failureReason: string | null;
  id: string;
  kind: string;
  sourcePath: string | null;
  status: QaEvidenceStatus;
  title: string;
};

export type QaEvidenceProducerContext = {
  commands: { path: string; preview: string | null } | null;
  kind: "ux-matrix";
  manifest: { path: string; runStatus: string | null; runId: string | null } | null;
  matrix: {
    cells: number;
    counts: Record<string, number>;
    path: string;
    stages: string[];
    surfaces: string[];
  } | null;
  preflight: { adbDevicesPath: string | null; memoryPath: string | null };
  releaseLedger: { counts: Record<string, number>; path: string } | null;
  rootPath: string;
  scorecard: { path: string; preview: string | null } | null;
};

export type QaEvidenceGalleryModel = {
  counts: Record<QaEvidenceStatus, number>;
  entries: QaEvidenceGalleryEntryView[];
  evidenceMode: string;
  evidencePath: string;
  generatedAt: string;
  profile: string | null;
  producerContext: QaEvidenceProducerContext | null;
  schemaVersion: number;
};

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathIfExists(filePath: string): Promise<string | null> {
  return fs.realpath(filePath).catch(() => null);
}

export async function resolveQaEvidenceFile(params: {
  inputPath: string;
  repoRoot: string;
}): Promise<string> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const raw = params.inputPath.trim();
  if (!raw) {
    throw new Error("Evidence path is required.");
  }
  const candidate = path.resolve(repoRoot, raw);
  const realCandidate = await realpathIfExists(candidate);
  if (!realCandidate || !isInside(repoRoot, realCandidate)) {
    throw new Error("Evidence path must exist inside the repo root.");
  }
  const stats = await fs.stat(realCandidate);
  const evidencePath = stats.isDirectory()
    ? path.join(realCandidate, QA_EVIDENCE_FILENAME)
    : realCandidate;
  const realEvidencePath = await realpathIfExists(evidencePath);
  if (!realEvidencePath || !isInside(repoRoot, realEvidencePath)) {
    throw new Error("qa-evidence.json must exist inside the repo root.");
  }
  return realEvidencePath;
}

export async function resolveQaEvidenceArtifactFile(params: {
  artifactPath: string;
  evidencePath: string;
  repoRoot: string;
}): Promise<string> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidenceDir = path.dirname(
    await resolveQaEvidenceFile({
      inputPath: params.evidencePath,
      repoRoot,
    }),
  );
  const raw = params.artifactPath.trim();
  if (!raw) {
    throw new Error("Artifact path is required.");
  }
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [path.resolve(repoRoot, raw), path.resolve(evidenceDir, raw)];
  for (const candidate of candidates) {
    const realCandidate = await realpathIfExists(candidate);
    if (!realCandidate) {
      continue;
    }
    if (!isInside(repoRoot, realCandidate) && !isInside(evidenceDir, realCandidate)) {
      continue;
    }
    const stats = await fs.stat(realCandidate);
    if (stats.isFile()) {
      return realCandidate;
    }
  }
  throw new Error("Evidence artifact not found.");
}

function classifyArtifact(kind: string, filePath: string): QaEvidenceArtifactView["mediaKind"] {
  const normalizedKind = kind.toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  if (
    normalizedKind.includes("screenshot") ||
    normalizedKind.includes("gif") ||
    [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)
  ) {
    return "image";
  }
  if (normalizedKind.includes("video") || [".webm", ".mp4", ".mov"].includes(ext)) {
    return "video";
  }
  if (
    normalizedKind.includes("validation") ||
    normalizedKind.includes("json") ||
    ext === ".json" ||
    ext === ".jsonl"
  ) {
    return "json";
  }
  if (
    normalizedKind.includes("log") ||
    normalizedKind.includes("report") ||
    [".log", ".md", ".txt"].includes(ext)
  ) {
    return "text";
  }
  return "file";
}

async function readPreview(filePath: string, mediaKind: QaEvidenceArtifactView["mediaKind"]) {
  if (mediaKind !== "json" && mediaKind !== "text") {
    return null;
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_PREVIEW_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (mediaKind !== "json") {
      return text;
    }
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  } finally {
    await handle.close();
  }
}

async function readTextPreviewIfExists(filePath: string): Promise<string | null> {
  const realFile = await realpathIfExists(filePath);
  if (!realFile) {
    return null;
  }
  return readPreview(realFile, "text").catch(() => null);
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  const realFile = await realpathIfExists(filePath);
  if (!realFile) {
    return null;
  }
  try {
    const value = JSON.parse(await fs.readFile(realFile, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function artifactHref(evidencePath: string, artifactPath: string) {
  const params = new URLSearchParams({
    evidencePath,
    artifactPath,
  });
  return `/api/evidence/artifact?${params.toString()}`;
}

async function buildArtifactView(params: {
  artifact: QaEvidenceArtifact;
  evidencePath: string;
  repoRoot: string;
}): Promise<QaEvidenceArtifactView> {
  const mediaKind = classifyArtifact(params.artifact.kind, params.artifact.path);
  try {
    const artifactPath = await resolveQaEvidenceArtifactFile({
      artifactPath: params.artifact.path,
      evidencePath: params.evidencePath,
      repoRoot: params.repoRoot,
    });
    return {
      exists: true,
      error: null,
      href: artifactHref(params.evidencePath, params.artifact.path),
      kind: params.artifact.kind,
      mediaKind,
      path: params.artifact.path,
      preview: await readPreview(artifactPath, mediaKind).catch(
        (error: unknown) => `Preview unavailable: ${formatErrorMessage(error)}`,
      ),
      source: params.artifact.source,
    };
  } catch (error) {
    return {
      exists: false,
      error: formatErrorMessage(error),
      href: null,
      kind: params.artifact.kind,
      mediaKind,
      path: params.artifact.path,
      preview: null,
      source: params.artifact.source,
    };
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCountRecord(value: unknown): Record<string, number> {
  const record = readRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function readStringArray(values: Iterable<unknown>) {
  return Array.from(
    new Set(Array.from(values).filter((value): value is string => typeof value === "string")),
  ).sort();
}

async function candidateProducerRoots(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}) {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const roots = new Set<string>([path.dirname(params.evidencePath)]);
  for (const entry of params.summaryEntries) {
    for (const artifact of entry.execution?.artifacts ?? []) {
      const artifactPath = await resolveQaEvidenceArtifactFile({
        artifactPath: artifact.path,
        evidencePath: params.evidencePath,
        repoRoot,
      }).catch(() => null);
      if (!artifactPath) {
        continue;
      }
      let current = path.dirname(artifactPath);
      while (isInside(repoRoot, current)) {
        roots.add(current);
        const parent = path.dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
      }
    }
  }
  return Array.from(roots);
}

async function findUxMatrixProducerRoot(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}) {
  for (const candidate of await candidateProducerRoots(params)) {
    const [manifest, matrix] = await Promise.all([
      realpathIfExists(path.join(candidate, "manifest.json")),
      realpathIfExists(path.join(candidate, "matrix.json")),
    ]);
    if (manifest && matrix) {
      return candidate;
    }
  }
  return null;
}

async function buildProducerContext(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}): Promise<QaEvidenceProducerContext | null> {
  const rootPath = await findUxMatrixProducerRoot(params);
  if (!rootPath) {
    return null;
  }
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const manifestPath = path.join(rootPath, "manifest.json");
  const matrixPath = path.join(rootPath, "matrix.json");
  const releaseLedgerPath = path.join(rootPath, "release-ledger.json");
  const scorecardPath = path.join(rootPath, "scorecard.md");
  const commandsPath = path.join(rootPath, "commands.txt");
  const manifest = await readJsonIfExists(manifestPath);
  const matrix = await readJsonIfExists(matrixPath);
  const releaseLedger = await readJsonIfExists(releaseLedgerPath);
  const matrixCells = Array.isArray(matrix?.cells)
    ? (matrix.cells as Array<Record<string, unknown>>)
    : [];
  return {
    commands: (await realpathIfExists(commandsPath))
      ? {
          path: toRepoRelativePath(repoRoot, commandsPath),
          preview: await readTextPreviewIfExists(commandsPath),
        }
      : null,
    kind: "ux-matrix",
    manifest: manifest
      ? {
          path: toRepoRelativePath(repoRoot, manifestPath),
          runId: readString(readRecord(manifest.run)?.runId),
          runStatus: readString(readRecord(manifest.run)?.status),
        }
      : null,
    matrix: matrix
      ? {
          cells: matrixCells.length,
          counts: readCountRecord(matrix.counts),
          path: toRepoRelativePath(repoRoot, matrixPath),
          stages: readStringArray(matrixCells.map((cell) => cell.stage)),
          surfaces: readStringArray(matrixCells.map((cell) => cell.surface)),
        }
      : null,
    preflight: {
      adbDevicesPath: (await realpathIfExists(path.join(rootPath, "preflight", "adb-devices.txt")))
        ? toRepoRelativePath(repoRoot, path.join(rootPath, "preflight", "adb-devices.txt"))
        : null,
      memoryPath: (await realpathIfExists(path.join(rootPath, "preflight", "memory.txt")))
        ? toRepoRelativePath(repoRoot, path.join(rootPath, "preflight", "memory.txt"))
        : null,
    },
    releaseLedger: releaseLedger
      ? {
          counts: readCountRecord(releaseLedger.counts),
          path: toRepoRelativePath(repoRoot, releaseLedgerPath),
        }
      : null,
    rootPath: toRepoRelativePath(repoRoot, rootPath),
    scorecard: (await realpathIfExists(scorecardPath))
      ? {
          path: toRepoRelativePath(repoRoot, scorecardPath),
          preview: await readTextPreviewIfExists(scorecardPath),
        }
      : null,
  };
}

function toRepoRelativePath(repoRoot: string, filePath: string) {
  return path.relative(repoRoot, filePath);
}

export async function buildQaEvidenceGalleryModel(params: {
  evidencePath: string;
  repoRoot: string;
}): Promise<QaEvidenceGalleryModel> {
  const evidencePath = await resolveQaEvidenceFile({
    inputPath: params.evidencePath,
    repoRoot: params.repoRoot,
  });
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const counts: Record<QaEvidenceStatus, number> = {
    pass: 0,
    fail: 0,
    blocked: 0,
    skipped: 0,
  };
  const entries = await Promise.all(
    summary.entries.map(async (entry): Promise<QaEvidenceGalleryEntryView> => {
      counts[entry.result.status] += 1;
      return {
        artifacts: await Promise.all(
          (entry.execution?.artifacts ?? []).map((artifact) =>
            buildArtifactView({ artifact, evidencePath, repoRoot: params.repoRoot }),
          ),
        ),
        coverage: entry.coverage,
        failureReason: entry.result.failure?.reason ?? null,
        id: entry.test.id,
        kind: entry.test.kind,
        sourcePath: entry.test.source?.path ?? null,
        status: entry.result.status,
        title: entry.test.title,
      };
    }),
  );
  return {
    counts,
    entries,
    evidenceMode: summary.evidenceMode,
    evidencePath,
    generatedAt: summary.generatedAt,
    profile: summary.profile ?? null,
    producerContext: await buildProducerContext({
      evidencePath,
      repoRoot: params.repoRoot,
      summaryEntries: summary.entries,
    }),
    schemaVersion: summary.schemaVersion,
  };
}
