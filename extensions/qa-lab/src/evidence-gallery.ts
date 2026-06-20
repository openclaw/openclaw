// Qa Lab plugin module implements generic QA evidence gallery data.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  QaEvidenceArtifactView,
  QaEvidenceGalleryEntryView,
  QaEvidenceGalleryModel,
  QaEvidenceMatrixCellView,
  QaEvidenceProducerContext,
  QaEvidenceProducerContextFile,
} from "../shared/evidence-gallery-types.js";
import { toRepoRelativePath } from "./cli-paths.js";
import {
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryEntry,
} from "./evidence-summary.js";

export type {
  QaEvidenceArtifactView,
  QaEvidenceGalleryEntryView,
  QaEvidenceGalleryModel,
  QaEvidenceMatrixCellView,
  QaEvidenceProducerContext,
  QaEvidenceProducerContextFile,
} from "../shared/evidence-gallery-types.js";

const TEXT_PREVIEW_BYTES = 12 * 1024;
const ARTIFACT_VIEW_CONCURRENCY = 8;

const UX_MATRIX_PRODUCER_FILES = [
  { key: "commands", path: "commands.txt", previewKind: "text" },
  { key: "manifest", path: "manifest.json", previewKind: "json" },
  { key: "matrix", path: "matrix.json", previewKind: "json" },
  { key: "releaseLedger", path: "release-ledger.json", previewKind: "json" },
  { key: "scorecard", path: "scorecard.md", previewKind: "text" },
  { key: "memory", path: path.join("preflight", "memory.txt"), previewKind: "text" },
  { key: "adbDevices", path: path.join("preflight", "adb-devices.txt"), previewKind: "text" },
] as const;

type QaEvidenceArtifact = NonNullable<QaEvidenceSummaryEntry["execution"]>["artifacts"][number];

export class QaEvidenceGalleryError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "QaEvidenceGalleryError";
    this.statusCode = statusCode;
  }
}

function evidenceError(message: string, statusCode: number): QaEvidenceGalleryError {
  return new QaEvidenceGalleryError(message, statusCode);
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeGalleryText(
  value: string,
  params: {
    extraRoots?: readonly string[];
    repoRoot: string;
  },
) {
  const localRoots = [...new Set([params.repoRoot, ...(params.extraRoots ?? [])])];
  const roots = [
    ...localRoots.flatMap((root) => [
      { from: path.resolve(root), to: "<repo-root>" },
      { from: pathToFileURL(path.resolve(root)).href, to: "file://<repo-root>" },
    ]),
    { from: os.homedir(), to: "<home>" },
    { from: pathToFileURL(os.homedir()).href, to: "file://<home>" },
  ].filter((entry) => entry.from && entry.from !== path.parse(entry.from).root);
  return roots
    .toSorted((a, b) => b.from.length - a.from.length)
    .reduce((text, entry) => text.replaceAll(entry.from, entry.to), value);
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
    throw evidenceError("Evidence path is required.", 400);
  }
  const candidate = path.resolve(repoRoot, raw);
  const realCandidate = await realpathIfExists(candidate);
  if (!realCandidate) {
    throw evidenceError("Evidence path not found.", 404);
  }
  if (!isInside(repoRoot, realCandidate)) {
    throw evidenceError("Evidence path must stay inside the repo root.", 403);
  }
  const stats = await fs.stat(realCandidate);
  const evidencePath = stats.isDirectory()
    ? path.join(realCandidate, QA_EVIDENCE_FILENAME)
    : realCandidate;
  const realEvidencePath = await realpathIfExists(evidencePath);
  if (!realEvidencePath) {
    throw evidenceError("qa-evidence.json not found.", 404);
  }
  if (!isInside(repoRoot, realEvidencePath)) {
    throw evidenceError("qa-evidence.json must stay inside the repo root.", 403);
  }
  return realEvidencePath;
}

export async function resolveQaEvidenceArtifactFile(params: {
  artifactPath: string;
  evidencePath: string;
  repoRoot: string;
}): Promise<string> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidencePath = await resolveQaEvidenceFile({ inputPath: params.evidencePath, repoRoot });
  if (!params.artifactPath.trim()) {
    throw evidenceError("Artifact path is required.", 400);
  }
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const artifactFile = await resolveArtifactFileWithinRoots({
    artifactPath: params.artifactPath,
    evidenceDir: path.dirname(evidencePath),
    repoRoot,
  });
  if (!artifactFile) {
    throw evidenceError("Evidence artifact not found.", 404);
  }
  const allowedArtifactFiles = await collectDeclaredQaEvidenceArtifactFiles({
    evidencePath,
    repoRoot,
    summaryEntries: summary.entries,
  });
  if (allowedArtifactFiles.has(artifactFile)) {
    return artifactFile;
  }
  throw evidenceError("Evidence artifact is not declared by this evidence summary.", 403);
}

function isExplicitRepoRootArtifactPath(raw: string): boolean {
  const normalized = raw.split(/[\\/]+/u).join("/");
  return normalized.startsWith(".artifacts/");
}

// Resolve an artifact path against pre-resolved roots without re-reading the evidence file.
// Returns null when the path is missing or escapes both roots; callers map that to an error.
async function resolveArtifactFileWithinRoots(params: {
  artifactPath: string;
  evidenceDir: string;
  repoRoot: string;
}): Promise<string | null> {
  const raw = params.artifactPath.trim();
  if (!raw) {
    return null;
  }
  const candidates = path.isAbsolute(raw) ? [raw] : [path.resolve(params.evidenceDir, raw)];
  if (!path.isAbsolute(raw) && isExplicitRepoRootArtifactPath(raw)) {
    candidates.push(path.resolve(params.repoRoot, raw));
  }
  for (const candidate of candidates) {
    const realCandidate = await realpathIfExists(candidate);
    if (!realCandidate) {
      continue;
    }
    if (!isInside(params.repoRoot, realCandidate) && !isInside(params.evidenceDir, realCandidate)) {
      continue;
    }
    const stats = await fs.stat(realCandidate).catch(() => null);
    if (stats?.isFile()) {
      return realCandidate;
    }
  }
  return null;
}

async function collectDeclaredQaEvidenceArtifactFiles(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}): Promise<Set<string>> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidenceDir = path.dirname(params.evidencePath);
  const allowed = new Set<string>();
  for (const entry of params.summaryEntries) {
    for (const artifact of entry.execution?.artifacts ?? []) {
      const artifactPath = await resolveArtifactFileWithinRoots({
        artifactPath: artifact.path,
        evidenceDir,
        repoRoot,
      });
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
      ...UX_MATRIX_PRODUCER_FILES.map((file) => file.path),
      QA_EVIDENCE_FILENAME,
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
  filePath: string;
  hrefEvidencePath: string;
  previewKind: "json" | "text";
  repoRoot: string;
}): Promise<QaEvidenceProducerContextFile | null> {
  const realFile = await resolveContainedFileIfExists(params.filePath, params.allowedRoots);
  if (!realFile) {
    return null;
  }
  const repoPath = toRepoRelativePath(params.repoRoot, params.filePath);
  return {
    href: artifactHref(params.hrefEvidencePath, params.artifactPath),
    path: repoPath,
    preview: await readPreview(realFile, params.previewKind).catch(() => null),
  };
}

async function buildArtifactView(params: {
  allowedArtifactFiles: ReadonlySet<string>;
  artifact: QaEvidenceArtifact;
  evidenceDir: string;
  hrefEvidencePath: string;
  repoRoot: string;
}): Promise<QaEvidenceArtifactView> {
  const mediaKind = classifyArtifact(params.artifact.kind, params.artifact.path);
  const realFile = await resolveArtifactFileWithinRoots({
    artifactPath: params.artifact.path,
    evidenceDir: params.evidenceDir,
    repoRoot: params.repoRoot,
  }).catch(() => null);
  if (!realFile || !params.allowedArtifactFiles.has(realFile)) {
    return {
      exists: false,
      error: realFile
        ? "Evidence artifact is not declared by this evidence summary."
        : "Evidence artifact not found.",
      href: null,
      kind: params.artifact.kind,
      mediaKind,
      path: params.artifact.path,
      preview: null,
      source: params.artifact.source,
    };
  }
  return {
    exists: true,
    error: null,
    href: artifactHref(params.hrefEvidencePath, params.artifact.path),
    kind: params.artifact.kind,
    mediaKind,
    path: params.artifact.path,
    preview: await readPreview(realFile, mediaKind).catch(
      (error: unknown) => `Preview unavailable: ${formatErrorMessage(error)}`,
    ),
    source: params.artifact.source,
  };
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
  return readOrderedStringArray(values).toSorted();
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
    ? params.matrix.cells
        .map(readRecord)
        .filter((cell): cell is Record<string, unknown> => Boolean(cell))
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
  const evidenceDir = path.dirname(params.evidencePath);
  const roots = new Set<string>([evidenceDir]);
  for (const entry of params.summaryEntries) {
    for (const artifact of entry.execution?.artifacts ?? []) {
      const artifactPath = await resolveArtifactFileWithinRoots({
        artifactPath: artifact.path,
        evidenceDir,
        repoRoot,
      });
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
  hrefEvidencePath: string;
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
  const producerPaths = Object.fromEntries(
    UX_MATRIX_PRODUCER_FILES.map((file) => [file.key, path.join(rootPath, file.path)]),
  ) as Record<(typeof UX_MATRIX_PRODUCER_FILES)[number]["key"], string>;
  const manifestPath = producerPaths.manifest;
  const matrixPath = producerPaths.matrix;
  const releaseLedgerPath = producerPaths.releaseLedger;
  const manifest = await readJsonIfExists(manifestPath, allowedRoots);
  const matrix = await readJsonIfExists(matrixPath, allowedRoots);
  const releaseLedger = await readJsonIfExists(releaseLedgerPath, allowedRoots);
  const producerFiles = Object.fromEntries(
    await Promise.all(
      UX_MATRIX_PRODUCER_FILES.map(async (file) => [
        file.key,
        await buildProducerContextFile({
          allowedRoots,
          artifactPath: toRepoRelativePath(repoRoot, producerPaths[file.key]),
          filePath: producerPaths[file.key],
          hrefEvidencePath: params.hrefEvidencePath,
          previewKind: file.previewKind,
          repoRoot,
        }),
      ]),
    ),
  ) as Record<
    (typeof UX_MATRIX_PRODUCER_FILES)[number]["key"],
    QaEvidenceProducerContextFile | null
  >;
  const matrixCells = readMatrixCells({
    matrix,
    summaryEntries: params.summaryEntries,
  });
  return {
    commands: producerFiles.commands,
    kind: "ux-matrix",
    manifest:
      manifest && producerFiles.manifest
        ? {
            ...producerFiles.manifest,
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
      adbDevices: producerFiles.adbDevices,
      memory: producerFiles.memory,
    },
    releaseLedger:
      releaseLedger && producerFiles.releaseLedger
        ? {
            ...producerFiles.releaseLedger,
            counts: readCountRecord(releaseLedger.counts),
          }
        : null,
    rootPath: toRepoRelativePath(repoRoot, rootPath),
    scorecard: producerFiles.scorecard,
  };
}

function createConcurrencyLimit(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

export async function buildQaEvidenceGalleryModel(params: {
  evidencePath: string;
  repoRoot: string;
}): Promise<QaEvidenceGalleryModel> {
  const requestedRepoRoot = path.resolve(params.repoRoot);
  const repoRoot = await fs.realpath(requestedRepoRoot);
  const evidencePath = await resolveQaEvidenceFile({
    inputPath: params.evidencePath,
    repoRoot,
  });
  const hrefEvidencePath = toRepoRelativePath(repoRoot, evidencePath);
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const counts: Record<QaEvidenceStatus, number> = {
    pass: 0,
    fail: 0,
    blocked: 0,
    skipped: 0,
  };
  // Resolve the declared-artifact allowlist once; buildArtifactView then only checks membership
  // instead of re-reading the evidence file and re-collecting the allowlist per artifact.
  const evidenceDir = path.dirname(evidencePath);
  const allowedArtifactFiles = await collectDeclaredQaEvidenceArtifactFiles({
    evidencePath,
    repoRoot,
    summaryEntries: summary.entries,
  });
  const limitArtifactView = createConcurrencyLimit(ARTIFACT_VIEW_CONCURRENCY);
  const entries = await Promise.all(
    summary.entries.map(async (entry): Promise<QaEvidenceGalleryEntryView> => {
      counts[entry.result.status] += 1;
      return {
        artifacts: await Promise.all(
          (entry.execution?.artifacts ?? []).map((artifact) =>
            limitArtifactView(() =>
              buildArtifactView({
                allowedArtifactFiles,
                artifact,
                evidenceDir,
                hrefEvidencePath,
                repoRoot,
              }),
            ),
          ),
        ),
        coverage: entry.coverage,
        failureReason: entry.result.failure?.reason
          ? sanitizeGalleryText(entry.result.failure.reason, {
              extraRoots: [requestedRepoRoot],
              repoRoot,
            })
          : null,
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
    evidencePath: hrefEvidencePath,
    generatedAt: summary.generatedAt,
    profile: summary.profile ?? null,
    producerContext: await buildProducerContext({
      evidencePath,
      hrefEvidencePath,
      repoRoot,
      summaryEntries: summary.entries,
    }),
    schemaVersion: summary.schemaVersion,
  };
}
