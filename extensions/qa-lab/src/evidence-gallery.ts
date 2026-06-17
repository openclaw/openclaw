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

export type QaEvidenceProducerContextFile = {
  href: string;
  path: string;
  preview: string | null;
};

export type QaEvidenceMatrixCellView = {
  artifactKinds: string[];
  artifactPaths: string[];
  coverageIds: string[];
  runner: {
    availability: string | null;
    command: string | null;
    lane: string | null;
    workflow: string | null;
  } | null;
  stage: string;
  status: string;
  surface: string;
  testId: string | null;
  title: string | null;
};

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
  commands: QaEvidenceProducerContextFile | null;
  kind: "ux-matrix";
  manifest:
    | (QaEvidenceProducerContextFile & {
        path: string;
        runStatus: string | null;
        runId: string | null;
      })
    | null;
  matrix: {
    cells: QaEvidenceMatrixCellView[];
    counts: Record<string, number>;
    path: string;
    stages: string[];
    surfaces: string[];
  } | null;
  preflight: {
    adbDevices: QaEvidenceProducerContextFile | null;
    memory: QaEvidenceProducerContextFile | null;
  };
  releaseLedger: (QaEvidenceProducerContextFile & { counts: Record<string, number> }) | null;
  rootPath: string;
  scorecard: QaEvidenceProducerContextFile | null;
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

async function resolveContainedFileIfExists(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  const realFile = await realpathIfExists(filePath);
  if (!realFile) {
    return null;
  }
  if (!allowedRoots.some((root) => isInside(root, realFile))) {
    return null;
  }
  const stats = await fs.stat(realFile).catch(() => null);
  return stats?.isFile() ? realFile : null;
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
  const evidencePath = await resolveQaEvidenceFile({
    inputPath: params.evidencePath,
    repoRoot: params.repoRoot,
  });
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const artifactFile = await resolveExistingQaEvidenceArtifactFile({
    artifactPath: params.artifactPath,
    evidencePath,
    repoRoot: params.repoRoot,
  });
  const allowedArtifactFiles = await collectDeclaredQaEvidenceArtifactFiles({
    evidencePath,
    repoRoot: params.repoRoot,
    summaryEntries: summary.entries,
  });
  if (allowedArtifactFiles.has(artifactFile)) {
    return artifactFile;
  }
  throw new Error("Evidence artifact is not declared by this evidence summary.");
}

async function resolveExistingQaEvidenceArtifactFile(params: {
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
    : [path.resolve(evidenceDir, raw), path.resolve(repoRoot, raw)];
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

async function collectDeclaredQaEvidenceArtifactFiles(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const entry of params.summaryEntries) {
    for (const artifact of entry.execution?.artifacts ?? []) {
      const artifactPath = await resolveExistingQaEvidenceArtifactFile({
        artifactPath: artifact.path,
        evidencePath: params.evidencePath,
        repoRoot: params.repoRoot,
      }).catch(() => null);
      if (artifactPath) {
        allowed.add(artifactPath);
      }
    }
  }
  const producerRoot = await findUxMatrixProducerRoot({
    evidencePath: params.evidencePath,
    repoRoot: params.repoRoot,
    summaryEntries: params.summaryEntries,
  });
  if (producerRoot) {
    const producerFiles = [
      "commands.txt",
      "manifest.json",
      "matrix.json",
      "qa-evidence.json",
      "release-ledger.json",
      "scorecard.md",
      path.join("preflight", "adb-devices.txt"),
      path.join("preflight", "memory.txt"),
    ];
    for (const producerFile of producerFiles) {
      const realProducerFile = await realpathIfExists(path.join(producerRoot, producerFile));
      if (realProducerFile) {
        allowed.add(realProducerFile);
      }
    }
  }
  return allowed;
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

async function readTextPreviewIfExists(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  const realFile = await resolveContainedFileIfExists(filePath, allowedRoots);
  if (!realFile) {
    return null;
  }
  return readPreview(realFile, "text").catch(() => null);
}

async function readJsonPreviewIfExists(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  const realFile = await resolveContainedFileIfExists(filePath, allowedRoots);
  if (!realFile) {
    return null;
  }
  return readPreview(realFile, "json").catch(() => null);
}

async function readJsonIfExists(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<Record<string, unknown> | null> {
  const realFile = await resolveContainedFileIfExists(filePath, allowedRoots);
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

async function buildProducerContextFile(params: {
  allowedRoots: readonly string[];
  artifactPath: string;
  evidencePath: string;
  filePath: string;
  previewKind: "json" | "text";
  repoRoot: string;
}): Promise<QaEvidenceProducerContextFile | null> {
  const realFile = await resolveContainedFileIfExists(params.filePath, params.allowedRoots);
  if (!realFile) {
    return null;
  }
  const repoPath = toRepoRelativePath(params.repoRoot, params.filePath);
  return {
    href: artifactHref(params.evidencePath, params.artifactPath),
    path: repoPath,
    preview:
      params.previewKind === "json"
        ? await readJsonPreviewIfExists(realFile, params.allowedRoots)
        : await readTextPreviewIfExists(realFile, params.allowedRoots),
  };
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

function readOrderedStringArray(values: Iterable<unknown>) {
  return Array.from(
    new Set(Array.from(values).filter((value): value is string => typeof value === "string")),
  );
}

function readStringArray(values: Iterable<unknown>) {
  return readOrderedStringArray(values).sort();
}

function readMatrixDimensionIds(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) {
    return readOrderedStringArray(fallback);
  }
  const ids = readOrderedStringArray(
    value.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      return readString(readRecord(entry)?.id);
    }),
  );
  for (const fallbackId of fallback) {
    if (!ids.includes(fallbackId)) {
      ids.push(fallbackId);
    }
  }
  return ids;
}

function uxMatrixEntryKey(
  entry: QaEvidenceSummaryEntry,
): { stage: string; surface: string } | null {
  const idMatch = /^ux-matrix\.([a-z0-9-]+)\.([a-z0-9-]+)$/u.exec(entry.test.id);
  if (idMatch) {
    return { surface: idMatch[1], stage: idMatch[2] };
  }
  for (const artifact of entry.execution?.artifacts ?? []) {
    const sourceMatch = /^ux-matrix:([a-z0-9-]+):([a-z0-9-]+)$/u.exec(artifact.source);
    if (sourceMatch) {
      return { surface: sourceMatch[1], stage: sourceMatch[2] };
    }
  }
  return null;
}

function buildUxMatrixEvidenceEntryIndex(entries: readonly QaEvidenceSummaryEntry[]) {
  const indexed = new Map<string, QaEvidenceSummaryEntry>();
  for (const entry of entries) {
    const key = uxMatrixEntryKey(entry);
    if (key) {
      indexed.set(`${key.surface}:${key.stage}`, entry);
    }
  }
  return indexed;
}

function readMatrixCells(params: {
  matrix: Record<string, unknown> | null;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}): QaEvidenceMatrixCellView[] {
  const rawCells = Array.isArray(params.matrix?.cells)
    ? (params.matrix.cells as Array<Record<string, unknown>>)
    : [];
  const entriesByCell = buildUxMatrixEvidenceEntryIndex(params.summaryEntries);
  return rawCells.flatMap((cell): QaEvidenceMatrixCellView[] => {
    const surface = readString(cell.surface);
    const stage = readString(cell.stage);
    const status = readString(cell.status) ?? "proof-gap";
    if (!surface || !stage) {
      return [];
    }
    const entry =
      status === "proof-gap" ? null : (entriesByCell.get(`${surface}:${stage}`) ?? null);
    const artifacts = entry?.execution?.artifacts ?? [];
    const runner = readRecord(cell.runner);
    return [
      {
        artifactKinds: readStringArray(artifacts.map((artifact) => artifact.kind)),
        artifactPaths: artifacts.map((artifact) => artifact.path),
        coverageIds: readStringArray(Array.isArray(cell.coverageIds) ? cell.coverageIds : []),
        runner: runner
          ? {
              availability: readString(runner.availability),
              command: readString(runner.command),
              lane: readString(runner.lane),
              workflow: readString(runner.workflow),
            }
          : null,
        stage,
        status,
        surface,
        testId: entry?.test.id ?? null,
        title: entry?.test.title ?? null,
      },
    ];
  });
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
      const artifactPath = await resolveExistingQaEvidenceArtifactFile({
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
  const evidenceDir = path.dirname(
    await resolveQaEvidenceFile({ inputPath: params.evidencePath, repoRoot }),
  );
  const allowedRoots = [repoRoot, evidenceDir];
  const manifestPath = path.join(rootPath, "manifest.json");
  const matrixPath = path.join(rootPath, "matrix.json");
  const releaseLedgerPath = path.join(rootPath, "release-ledger.json");
  const scorecardPath = path.join(rootPath, "scorecard.md");
  const commandsPath = path.join(rootPath, "commands.txt");
  const memoryPath = path.join(rootPath, "preflight", "memory.txt");
  const adbDevicesPath = path.join(rootPath, "preflight", "adb-devices.txt");
  const manifest = await readJsonIfExists(manifestPath, allowedRoots);
  const matrix = await readJsonIfExists(matrixPath, allowedRoots);
  const releaseLedger = await readJsonIfExists(releaseLedgerPath, allowedRoots);
  const [commandsFile, manifestFile, memoryFile, adbDevicesFile, releaseLedgerFile, scorecardFile] =
    await Promise.all([
      buildProducerContextFile({
        allowedRoots,
        artifactPath: toRepoRelativePath(repoRoot, commandsPath),
        evidencePath: params.evidencePath,
        filePath: commandsPath,
        previewKind: "text",
        repoRoot,
      }),
      buildProducerContextFile({
        allowedRoots,
        artifactPath: toRepoRelativePath(repoRoot, manifestPath),
        evidencePath: params.evidencePath,
        filePath: manifestPath,
        previewKind: "json",
        repoRoot,
      }),
      buildProducerContextFile({
        allowedRoots,
        artifactPath: toRepoRelativePath(repoRoot, memoryPath),
        evidencePath: params.evidencePath,
        filePath: memoryPath,
        previewKind: "text",
        repoRoot,
      }),
      buildProducerContextFile({
        allowedRoots,
        artifactPath: toRepoRelativePath(repoRoot, adbDevicesPath),
        evidencePath: params.evidencePath,
        filePath: adbDevicesPath,
        previewKind: "text",
        repoRoot,
      }),
      buildProducerContextFile({
        allowedRoots,
        artifactPath: toRepoRelativePath(repoRoot, releaseLedgerPath),
        evidencePath: params.evidencePath,
        filePath: releaseLedgerPath,
        previewKind: "json",
        repoRoot,
      }),
      buildProducerContextFile({
        allowedRoots,
        artifactPath: toRepoRelativePath(repoRoot, scorecardPath),
        evidencePath: params.evidencePath,
        filePath: scorecardPath,
        previewKind: "text",
        repoRoot,
      }),
    ]);
  const matrixCells = readMatrixCells({
    matrix,
    summaryEntries: params.summaryEntries,
  });
  return {
    commands: commandsFile,
    kind: "ux-matrix",
    manifest:
      manifest && manifestFile
        ? {
            ...manifestFile,
            runId: readString(readRecord(manifest.run)?.runId),
            runStatus: readString(readRecord(manifest.run)?.status),
          }
        : null,
    matrix: matrix
      ? {
          cells: matrixCells,
          counts: readCountRecord(matrix.counts),
          path: toRepoRelativePath(repoRoot, matrixPath),
          stages: readMatrixDimensionIds(
            matrix.stages,
            matrixCells.map((cell) => cell.stage),
          ),
          surfaces: readMatrixDimensionIds(
            matrix.surfaces,
            matrixCells.map((cell) => cell.surface),
          ),
        }
      : null,
    preflight: {
      adbDevices: adbDevicesFile,
      memory: memoryFile,
    },
    releaseLedger:
      releaseLedger && releaseLedgerFile
        ? {
            ...releaseLedgerFile,
            counts: readCountRecord(releaseLedger.counts),
          }
        : null,
    rootPath: toRepoRelativePath(repoRoot, rootPath),
    scorecard: scorecardFile,
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
