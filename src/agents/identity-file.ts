/**
 * IDENTITY.md parsing and writing support.
 * The parser accepts human-authored markdown, while the writer only updates
 * stable rich identity fields.
 */
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync, readFileDescriptorBoundedSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { IdentityConfig } from "../config/types.base.js";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace-bootstrap-policy.js";

// IDENTITY.md may contain the supported 2 MiB avatar encoded as a roughly
// 2.7 MiB data URL. Keep bounded headroom for the remaining identity fields.
const MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

/** Parsed rich identity values from a workspace `IDENTITY.md` file. */
export type AgentIdentityFile = {
  name?: string;
  emoji?: string;
  theme?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
};

const WRITABLE_IDENTITY_FIELDS = [
  ["name", "Name"],
  ["theme", "Theme"],
  ["emoji", "Emoji"],
  ["avatar", "Avatar"],
] as const satisfies ReadonlyArray<readonly [keyof AgentIdentityFile, string]>;

const RICH_IDENTITY_LABELS = new Set(["name", "creature", "vibe", "theme", "emoji", "avatar"]);

const IDENTITY_PLACEHOLDER_VALUES = new Set([
  "not set yet",
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

export function sanitizeAgentIdentityLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactIdentityConfig(identity: IdentityConfig): IdentityConfig | undefined {
  const resolved: IdentityConfig = {};
  for (const [field] of WRITABLE_IDENTITY_FIELDS) {
    const value = identity[field]?.trim();
    if (value) {
      resolved[field] = value;
    }
  }
  return Object.keys(resolved).length ? resolved : undefined;
}

export function createAgentIdentityConfig(params: {
  name?: string;
  emoji?: unknown;
  avatar?: unknown;
}): IdentityConfig | undefined {
  return compactIdentityConfig({
    ...(params.name ? { name: sanitizeAgentIdentityLine(params.name) } : {}),
    emoji: sanitizeAgentIdentityLine(normalizeOptionalString(params.emoji) ?? ""),
    avatar: sanitizeAgentIdentityLine(normalizeOptionalString(params.avatar) ?? ""),
  });
}

export function normalizeIdentityForFile(
  identity: IdentityConfig | undefined,
): IdentityConfig | undefined {
  return identity ? compactIdentityConfig(identity) : undefined;
}

function normalizeIdentityValue(value: string): string {
  // Normalize markdown decoration and punctuation so generated template
  // placeholders do not accidentally become real identity values.
  let normalized = value.trim();
  normalized = normalized.replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim();
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/[\u2013\u2014]/g, "-");
  return normalizeLowercaseStringOrEmpty(normalized.replace(/\s+/g, " "));
}

function normalizeIdentityLabel(label: string): string {
  return normalizeLowercaseStringOrEmpty(label.replace(/[*_`]/g, ""));
}

function isIdentityPlaceholder(value: string): boolean {
  const normalized = normalizeIdentityValue(value);
  return IDENTITY_PLACEHOLDER_VALUES.has(normalized);
}

/** Parse rich identity fields from human-authored markdown content. */
function parseIdentityMarkdown(content: string): AgentIdentityFile | null {
  const identity: AgentIdentityFile = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const label = normalizeIdentityLabel(cleaned.slice(0, colonIndex));
    const value = cleaned
      .slice(colonIndex + 1)
      .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
      .trim();
    if (!value) {
      continue;
    }
    if (isIdentityPlaceholder(value)) {
      continue;
    }
    switch (label) {
      case "name":
      case "emoji":
      case "creature":
      case "vibe":
      case "theme":
      case "avatar":
        identity[label] = value;
    }
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

function matchesIdentityLabel(line: string, label: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("-")) {
    return false;
  }
  const cleaned = trimmed.replace(/^\s*-\s*/, "");
  const colonIndex = cleaned.indexOf(":");
  if (colonIndex === -1) {
    return false;
  }
  return normalizeIdentityLabel(cleaned.slice(0, colonIndex)) === normalizeIdentityLabel(label);
}

function resolveIdentityInsertIndex(lines: string[]): number {
  // New fields stay grouped with existing rich identity fields; otherwise place
  // them directly after the title block so legacy prose remains intact.
  let lastIdentityIndex = -1;
  for (const [index, line] of lines.entries()) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const label = normalizeIdentityLabel(cleaned.slice(0, colonIndex));
    if (RICH_IDENTITY_LABELS.has(label)) {
      lastIdentityIndex = index;
    }
  }
  if (lastIdentityIndex >= 0) {
    return lastIdentityIndex + 1;
  }

  const headingIndex = lines.findIndex((line) => line.trim().startsWith("#"));
  if (headingIndex === -1) {
    return 0;
  }
  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex]?.trim() === "") {
    insertIndex += 1;
  }
  return insertIndex;
}

/**
 * Merge writable identity fields into existing IDENTITY.md content, replacing
 * duplicate labels and preserving unrelated markdown.
 */
export function mergeIdentityMarkdownContent(
  content: string | undefined,
  identity: Pick<AgentIdentityFile, "name" | "theme" | "emoji" | "avatar">,
): string {
  const nextLines = content
    ? content.replace(/\r\n/g, "\n").split("\n")
    : ["# IDENTITY.md - Agent Identity", ""];

  for (const [field, label] of WRITABLE_IDENTITY_FIELDS) {
    const value = identity[field]?.trim();
    if (!value) {
      continue;
    }
    const identityLine = `- ${label}: ${value}`;

    const matchingIndexes = nextLines.reduce<number[]>((indexes, line, index) => {
      if (matchesIdentityLabel(line, label)) {
        indexes.push(index);
      }
      return indexes;
    }, []);

    if (matchingIndexes.length > 0) {
      const [firstIndex, ...duplicateIndexes] = matchingIndexes;
      if (firstIndex === undefined) {
        continue;
      }
      nextLines[firstIndex] = identityLine;
      for (const duplicateIndex of duplicateIndexes.toReversed()) {
        nextLines.splice(duplicateIndex, 1);
      }
      continue;
    }

    const insertIndex = resolveIdentityInsertIndex(nextLines);
    nextLines.splice(insertIndex, 0, identityLine);
  }

  return nextLines.join("\n").replace(/\n*$/, "\n");
}

export async function buildIdentityMarkdownForWrite(params: {
  readWorkspaceFileContent: (workspaceDir: string, name: string) => Promise<string | undefined>;
  workspaceDir: string;
  identity: IdentityConfig;
  fallbackWorkspaceDir?: string;
  preferFallbackWorkspaceContent?: boolean;
}): Promise<string> {
  // Workspace moves prefer the previous user-edited file over a newly seeded one.
  const workspaces = params.fallbackWorkspaceDir
    ? params.preferFallbackWorkspaceContent
      ? [params.fallbackWorkspaceDir, params.workspaceDir]
      : [params.workspaceDir, params.fallbackWorkspaceDir]
    : [params.workspaceDir];
  for (const workspaceDir of workspaces) {
    const content = await params.readWorkspaceFileContent(workspaceDir, DEFAULT_IDENTITY_FILENAME);
    if (content !== undefined) {
      return mergeIdentityMarkdownContent(content, params.identity);
    }
  }
  return mergeIdentityMarkdownContent(undefined, params.identity);
}

export type IdentityFileRead = { identityPath: string; knownRevision?: string };
export type IdentityFileSnapshot =
  | { kind: "unchanged" }
  | { kind: "loaded"; revision: string; size: number; identity: AgentIdentityFile | null }
  | { kind: "missing" | "too-large" };

/** Shared admission kernel for the worker and the shipped synchronous SDK reader. */
export function readIdentityFileSnapshot(input: IdentityFileRead): IdentityFileSnapshot {
  try {
    const resolvedPath = fs.realpathSync(input.identityPath);
    const opened = openRootFileSync({
      absolutePath: resolvedPath,
      rootPath: path.dirname(resolvedPath),
      rootRealPath: path.dirname(resolvedPath),
      boundaryLabel: "identity file directory",
      rejectHardlinks: false,
    });
    if (!opened.ok) {
      return { kind: "missing" };
    }
    try {
      const { dev, ino, size, mtimeMs, ctimeMs } = opened.stat;
      if (size > MAX_IDENTITY_FILE_BYTES) {
        return { kind: "too-large" };
      }
      const revision = JSON.stringify([opened.path, dev, ino, size, mtimeMs, ctimeMs]);
      if (revision === input.knownRevision) {
        return { kind: "unchanged" };
      }
      const buffer = readFileDescriptorBoundedSync(opened.fd, MAX_IDENTITY_FILE_BYTES);
      const identity = parseIdentityMarkdown(buffer.toString("utf-8"));
      return {
        kind: "loaded",
        revision,
        size: buffer.byteLength,
        identity,
      };
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch (error) {
    return {
      kind: error instanceof FsSafeError && error.code === "too-large" ? "too-large" : "missing",
    };
  }
}

/** Load a specific identity file when it exists and contains real values. */
export async function loadAgentIdentityFromFile(
  identityPath: string,
): Promise<AgentIdentityFile | null> {
  const { prepareIdentityFile } = await import("./identity-file-runtime.js");
  const result = await prepareIdentityFile(identityPath);
  if (result.kind === "too-large") {
    throw new Error(
      `Identity file ${identityPath} exceeds the maximum size of ${MAX_IDENTITY_FILE_BYTES} bytes`,
      {
        cause: new FsSafeError(
          "too-large",
          `File exceeds ${MAX_IDENTITY_FILE_BYTES} bytes: ${identityPath}`,
        ),
      },
    );
  }
  return result.kind === "loaded" ? result.identity : null;
}

/** Retained synchronous contract for the shipped agent-avatar Plugin SDK facade. */
export function loadAgentIdentityFromWorkspace(workspace: string): AgentIdentityFile | null {
  const result = readIdentityFileSnapshot({
    identityPath: path.join(workspace, DEFAULT_IDENTITY_FILENAME),
  });
  return result.kind === "loaded" ? result.identity : null;
}

/** Workspace presentation treats unavailable or unreadable identity files as absent. */
export async function loadAgentIdentityFromWorkspaceAsync(
  workspace: string,
): Promise<AgentIdentityFile | null> {
  try {
    const { prepareIdentityFile } = await import("./identity-file-runtime.js");
    const result = await prepareIdentityFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME));
    return result.kind === "loaded" ? result.identity : null;
  } catch {
    return null;
  }
}
