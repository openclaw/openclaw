import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const CODEX_NATIVE_ARTIFACT_DIRS = [
  "generated_images",
  "generated_media",
  "generated_files",
  "generated_documents",
  "generated_audio",
  "generated_videos",
] as const;

const DELIVERABLE_ARTIFACT_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".csv",
  ".doc",
  ".docx",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".md",
  ".mov",
  ".mp3",
  ".mp4",
  ".odp",
  ".ods",
  ".odt",
  ".ogg",
  ".opus",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rtf",
  ".svg",
  ".tsv",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);

const MAX_ARTIFACT_SCAN_DEPTH = 5;
const MAX_NATIVE_ARTIFACTS = 20;

type ArtifactEntry = {
  path: string;
  mtimeMs: number;
  size: number;
};

export type CodexNativeArtifactSnapshot = {
  roots: string[];
  files: Map<string, ArtifactEntry>;
};

type ResultWithMedia = {
  assistantTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  toolMediaUrls?: string[];
};

function isDeliverableArtifact(filePath: string): boolean {
  return DELIVERABLE_ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function codexNativeArtifactRoots(codexHome: string | undefined): string[] {
  const normalizedHome = codexHome?.trim();
  if (!normalizedHome) {
    return [];
  }
  const resolvedHome = path.resolve(normalizedHome);
  return CODEX_NATIVE_ARTIFACT_DIRS.map((dirName) => path.join(resolvedHome, dirName));
}

async function listArtifactsInRoot(
  root: string,
  options: { depth?: number } = {},
): Promise<ArtifactEntry[]> {
  const depth = options.depth ?? 0;
  if (depth > MAX_ARTIFACT_SCAN_DEPTH) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // Artifact discovery decorates an already-completed turn. A filesystem
    // race, platform ACL error, or locked generated subtree must not fail the
    // assistant reply.
    return [];
  }

  const artifacts: ArtifactEntry[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...(await listArtifactsInRoot(entryPath, { depth: depth + 1 })));
      continue;
    }
    if (!entry.isFile() || !isDeliverableArtifact(entryPath)) {
      continue;
    }
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }
    if (stat.size <= 0) {
      continue;
    }
    artifacts.push({
      path: path.resolve(entryPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
  return artifacts;
}

async function listCodexNativeArtifacts(roots: readonly string[]): Promise<ArtifactEntry[]> {
  const artifacts: ArtifactEntry[] = [];
  for (const root of roots) {
    artifacts.push(...(await listArtifactsInRoot(root)));
  }
  return artifacts;
}

export async function snapshotCodexNativeArtifacts(
  codexHome: string | undefined,
): Promise<CodexNativeArtifactSnapshot> {
  const roots = codexNativeArtifactRoots(codexHome);
  const files = new Map<string, ArtifactEntry>();
  for (const artifact of await listCodexNativeArtifacts(roots)) {
    files.set(artifact.path, artifact);
  }
  return { roots, files };
}

export async function collectNewCodexNativeArtifacts(
  snapshot: CodexNativeArtifactSnapshot,
): Promise<string[]> {
  if (snapshot.roots.length === 0) {
    return [];
  }
  const newArtifacts: ArtifactEntry[] = [];
  for (const artifact of await listCodexNativeArtifacts(snapshot.roots)) {
    const previous = snapshot.files.get(artifact.path);
    if (
      previous &&
      previous.size === artifact.size &&
      Math.floor(previous.mtimeMs) === Math.floor(artifact.mtimeMs)
    ) {
      continue;
    }
    newArtifacts.push(artifact);
  }
  return newArtifacts
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, MAX_NATIVE_ARTIFACTS)
    .map((artifact) => artifact.path);
}

function hasAssistantMediaDirective(texts: readonly string[] | undefined): boolean {
  return texts?.some((text) => /(^|\n)\s*MEDIA:/iu.test(text)) ?? false;
}

function hasVisibleAssistantText(texts: readonly string[] | undefined): boolean {
  return texts?.some((text) => text.trim().length > 0) ?? false;
}

function describeArtifact(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".apng":
    case ".avif":
    case ".bmp":
    case ".gif":
    case ".heic":
    case ".heif":
    case ".jpeg":
    case ".jpg":
    case ".png":
    case ".svg":
    case ".webp":
      return "image";
    case ".pdf":
      return "PDF";
    case ".csv":
    case ".ods":
    case ".tsv":
    case ".xls":
    case ".xlsx":
      return "spreadsheet";
    case ".doc":
    case ".docx":
    case ".md":
    case ".odt":
    case ".rtf":
    case ".txt":
      return "document";
    case ".odp":
    case ".ppt":
    case ".pptx":
      return "presentation";
    case ".m4a":
    case ".mp3":
    case ".ogg":
    case ".opus":
    case ".wav":
      return "audio";
    case ".mov":
    case ".mp4":
    case ".webm":
      return "video";
    case ".zip":
      return "archive";
    default:
      return "file";
  }
}

function formatArtifactSummary(artifactPaths: readonly string[]): string {
  if (artifactPaths.length === 1 && artifactPaths[0]) {
    return `Generated ${describeArtifact(artifactPaths[0])} attached.`;
  }
  const kinds = Array.from(new Set(artifactPaths.map(describeArtifact)));
  if (kinds.length === 1 && kinds[0]) {
    return `Generated ${artifactPaths.length} ${kinds[0]} files attached.`;
  }
  return `Generated ${artifactPaths.length} files attached.`;
}

export function appendCodexNativeArtifactsToResult<T extends ResultWithMedia>(
  result: T,
  artifactPaths: readonly string[],
): T {
  if (
    artifactPaths.length === 0 ||
    (result.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    hasAssistantMediaDirective(result.assistantTexts)
  ) {
    return result;
  }

  const existingMedia = new Set(result.toolMediaUrls ?? []);
  const freshArtifacts = artifactPaths.filter((artifactPath) => {
    const trimmed = artifactPath.trim();
    return trimmed && !existingMedia.has(trimmed);
  });
  if (freshArtifacts.length === 0) {
    return result;
  }
  return {
    ...result,
    assistantTexts: hasVisibleAssistantText(result.assistantTexts)
      ? result.assistantTexts
      : [formatArtifactSummary(freshArtifacts)],
    toolMediaUrls: [...(result.toolMediaUrls ?? []), ...freshArtifacts],
  };
}
