import fs from "node:fs/promises";
import path from "node:path";
import { isFileMissingError, statRegularFile } from "./fs-utils.js";
import { hashText } from "./hash.js";

export const WORKSPACE_RECONCILER_ID = "workspace-reconciler";
export const WORKSPACE_RECONCILER_ROOTS = [
  "MEMORY.md",
  "memory",
  "rules-vault",
  "projects",
] as const;

const DEFAULT_WORKSPACE_CHUNK_MAX_CHARS = 4000;
const DEFAULT_TEXT_PREVIEW_MAX_CHARS = 160;

export type WorkspaceReconcileRoot = (typeof WORKSPACE_RECONCILER_ROOTS)[number];

export type WorkspaceReconcileFile = {
  absPath: string;
  path: string;
  root: WorkspaceReconcileRoot;
};

export type WorkspaceReconcileChunk = {
  text: string;
  title?: string;
};

export type WorkspaceReconcilePayload = {
  managed_by: typeof WORKSPACE_RECONCILER_ID;
  path: string;
  root: WorkspaceReconcileRoot;
  chunk_index: number;
  content_hash: string;
  text_preview: string;
  synced_at: string;
  title?: string;
};

export type WorkspaceReconcilePoint = {
  id: string;
  text: string;
  payload: WorkspaceReconcilePayload;
};

export type WorkspaceReconcilePlan = {
  files: WorkspaceReconcileFile[];
  points: WorkspaceReconcilePoint[];
};

type WorkspaceHeadingSection = {
  text: string;
  title?: string;
};

type ExistingWorkspacePoint = {
  id: string;
  payload?: {
    managed_by?: unknown;
  } | null;
};

function isMissingFileSystemEntry(err: unknown): boolean {
  return isFileMissingError(err);
}

function normalizeWorkspacePath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function isMarkdownFile(fileName: string): boolean {
  return fileName.endsWith(".md");
}

function compareDirEntries(
  left: { isDirectory(): boolean; name: string },
  right: { isDirectory(): boolean; name: string },
): number {
  if (left.isDirectory() && !right.isDirectory()) {
    return -1;
  }
  if (!left.isDirectory() && right.isDirectory()) {
    return 1;
  }
  return left.name.localeCompare(right.name);
}

async function walkMarkdownTree(
  workspaceDir: string,
  rootDir: string,
  root: Exclude<WorkspaceReconcileRoot, "MEMORY.md">,
): Promise<WorkspaceReconcileFile[]> {
  const result: WorkspaceReconcileFile[] = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      if (isMissingFileSystemEntry(err)) {
        continue;
      }
      throw err;
    }
    entries.sort(compareDirEntries);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const absPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(absPath);
        continue;
      }
      if (!entry.isFile() || !isMarkdownFile(entry.name)) {
        continue;
      }
      result.push({
        absPath,
        path: normalizeWorkspacePath(path.relative(workspaceDir, absPath)),
        root,
      });
    }
  }
  return result.toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function collectWorkspaceReconcileFiles(
  workspaceDir: string,
): Promise<WorkspaceReconcileFile[]> {
  const result: WorkspaceReconcileFile[] = [];

  const memoryFilePath = path.join(workspaceDir, "MEMORY.md");
  const memoryFileStat = await statRegularFile(memoryFilePath).catch((err) => {
    if (isMissingFileSystemEntry(err)) {
      return { missing: true as const };
    }
    throw err;
  });
  if (!memoryFileStat.missing) {
    result.push({
      absPath: memoryFilePath,
      path: "MEMORY.md",
      root: "MEMORY.md",
    });
  }

  for (const root of WORKSPACE_RECONCILER_ROOTS) {
    if (root === "MEMORY.md") {
      continue;
    }
    const rootDir = path.join(workspaceDir, root);
    const rootStat = await fs
      .lstat(rootDir)
      .then((stat) => ({ missing: false as const, stat }))
      .catch((err) => {
        if (isMissingFileSystemEntry(err)) {
          return { missing: true as const };
        }
        throw err;
      });
    if (rootStat.missing || rootStat.stat.isSymbolicLink() || !rootStat.stat.isDirectory()) {
      continue;
    }
    result.push(...(await walkMarkdownTree(workspaceDir, rootDir, root)));
  }

  return result;
}

function normalizeMarkdownContent(content: string): string {
  return content.replace(/\r\n?/g, "\n").trim();
}

function extractHeadingTitle(line: string): string | undefined {
  const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line.trim());
  return match?.[1]?.trim() || undefined;
}

function isFenceDelimiterLine(line: string): boolean {
  return /^(?:```|~~~)/u.test(line.trim());
}

function splitHeadingSections(content: string): WorkspaceHeadingSection[] {
  const normalized = normalizeMarkdownContent(content);
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  const result: WorkspaceHeadingSection[] = [];
  let currentLines: string[] = [];
  let currentTitle: string | undefined;
  let inFenceBlock = false;

  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (!text) {
      currentLines = [];
      currentTitle = undefined;
      return;
    }
    result.push({ text, ...(currentTitle ? { title: currentTitle } : {}) });
    currentLines = [];
    currentTitle = undefined;
  };

  for (const line of lines) {
    const nextTitle = inFenceBlock ? undefined : extractHeadingTitle(line);
    if (nextTitle) {
      flush();
      currentTitle = nextTitle;
    }
    currentLines.push(line);
    if (isFenceDelimiterLine(line)) {
      inFenceBlock = !inFenceBlock;
    }
  }
  flush();
  return result;
}

function splitParagraphGroups(content: string): string[] {
  return content
    .split(/\n{2,}/u)
    .map((group) => group.trim())
    .filter(Boolean);
}

function splitOversizedText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const lines = text.split("\n");
  const result: string[] = [];
  let current = "";

  const flush = () => {
    const normalized = current.trim();
    if (normalized) {
      result.push(normalized);
    }
    current = "";
  };

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      if (current.length <= maxChars) {
        continue;
      }
    }
    if (current && current.length > maxChars) {
      let remaining = current;
      while (remaining.length > maxChars) {
        result.push(remaining.slice(0, maxChars).trim());
        remaining = remaining.slice(maxChars).trim();
      }
      current = remaining;
      continue;
    }
    flush();
    current = line;
  }

  if (current.length > maxChars) {
    let remaining = current;
    while (remaining.length > maxChars) {
      result.push(remaining.slice(0, maxChars).trim());
      remaining = remaining.slice(maxChars).trim();
    }
    current = remaining;
  }
  flush();
  return result;
}

function splitSectionByParagraphGroups(
  section: WorkspaceHeadingSection,
  maxChars: number,
): WorkspaceReconcileChunk[] {
  if (section.text.length <= maxChars) {
    return [section];
  }

  const lines = section.text.split("\n");
  const headingLine =
    section.title && lines.length > 0 && extractHeadingTitle(lines[0]) ? lines[0].trim() : "";
  const bodyText = headingLine ? lines.slice(1).join("\n").trim() : section.text;
  const groups = splitParagraphGroups(bodyText);

  if (groups.length === 0) {
    return splitOversizedText(section.text, maxChars).map((text) => ({
      text,
      ...(section.title ? { title: section.title } : {}),
    }));
  }

  const result: WorkspaceReconcileChunk[] = [];
  let currentGroups: string[] = [];

  const materialize = (parts: string[]) => {
    const body = parts.join("\n\n").trim();
    return headingLine ? `${headingLine}\n\n${body}`.trim() : body;
  };

  const flush = () => {
    if (currentGroups.length === 0) {
      return;
    }
    result.push({
      text: materialize(currentGroups),
      ...(section.title ? { title: section.title } : {}),
    });
    currentGroups = [];
  };

  for (const group of groups) {
    const candidateGroups = [...currentGroups, group];
    const candidateText = materialize(candidateGroups);
    if (candidateText.length <= maxChars) {
      currentGroups = candidateGroups;
      continue;
    }
    if (currentGroups.length > 0) {
      flush();
    }
    const singleGroupText = materialize([group]);
    if (singleGroupText.length <= maxChars) {
      currentGroups = [group];
      continue;
    }
    for (const oversizedPart of splitOversizedText(singleGroupText, maxChars)) {
      result.push({
        text: oversizedPart,
        ...(section.title ? { title: section.title } : {}),
      });
    }
  }

  flush();
  return result;
}

export function chunkWorkspaceMarkdownByHeading(
  content: string,
  maxChars = DEFAULT_WORKSPACE_CHUNK_MAX_CHARS,
): WorkspaceReconcileChunk[] {
  if (maxChars <= 0) {
    throw new Error("maxChars must be greater than 0");
  }
  const sections = splitHeadingSections(content);
  const result: WorkspaceReconcileChunk[] = [];
  for (const section of sections) {
    result.push(...splitSectionByParagraphGroups(section, maxChars));
  }
  return result;
}

function buildTextPreview(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, DEFAULT_TEXT_PREVIEW_MAX_CHARS);
}

export async function buildWorkspaceReconcilePlan(
  workspaceDir: string,
  nowIso: string,
): Promise<WorkspaceReconcilePlan> {
  const files = await collectWorkspaceReconcileFiles(workspaceDir);
  const points: WorkspaceReconcilePoint[] = [];

  for (const file of files) {
    const content = await fs.readFile(file.absPath, "utf8");
    const chunks = chunkWorkspaceMarkdownByHeading(content);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const contentHash = hashText(chunk.text);
      points.push({
        id: `workspace:${file.path}#${chunkIndex}`,
        text: chunk.text,
        payload: {
          managed_by: WORKSPACE_RECONCILER_ID,
          path: file.path,
          root: file.root,
          chunk_index: chunkIndex,
          content_hash: contentHash,
          text_preview: buildTextPreview(chunk.text),
          synced_at: nowIso,
          ...(chunk.title ? { title: chunk.title } : {}),
        },
      });
    }
  }

  return { files, points };
}

export function computeWorkspaceReconcileDeleteCandidates(
  existingPoints: ExistingWorkspacePoint[],
  nextIds: ReadonlySet<string>,
): string[] {
  return existingPoints
    .filter(
      (point) => point.payload?.managed_by === WORKSPACE_RECONCILER_ID && !nextIds.has(point.id),
    )
    .map((point) => point.id);
}
