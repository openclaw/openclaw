import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync, readFileDescriptorBoundedSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { findMarkdownCodeRegions } from "../../packages/markdown-core/src/markdown-code-regions.js";
import type { IdentityConfig } from "../config/types.base.js";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace-bootstrap-policy.js";

// IDENTITY.md may contain the supported 2 MiB avatar encoded as a roughly
// 2.7 MiB data URL. Keep bounded headroom for the remaining identity fields.
const MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

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

const RICH_IDENTITY_LABELS = ["name", "creature", "vibe", "theme", "emoji", "avatar"] as const;

function isRichIdentityLabel(label: string): label is (typeof RICH_IDENTITY_LABELS)[number] {
  return RICH_IDENTITY_LABELS.some((field) => field === label);
}

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

export function normalizeIdentityForFile(
  identity: IdentityConfig | undefined,
): IdentityConfig | undefined {
  const resolved: IdentityConfig = {};
  for (const [field] of WRITABLE_IDENTITY_FIELDS) {
    const value = identity?.[field]?.trim();
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
  return normalizeIdentityForFile({
    ...(params.name ? { name: sanitizeAgentIdentityLine(params.name) } : {}),
    emoji: sanitizeAgentIdentityLine(normalizeOptionalString(params.emoji) ?? ""),
    avatar: sanitizeAgentIdentityLine(normalizeOptionalString(params.avatar) ?? ""),
  });
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

function parseIdentityLine(line: string): { label: string; value: string } | undefined {
  const cleaned = line
    .trim()
    .replace(/^\s*-\s*/, "")
    .replace(/^([*_`]+)([A-Za-z]+):\1/u, "$2:");
  const colonIndex = cleaned.indexOf(":");
  return colonIndex === -1
    ? undefined
    : {
        label: normalizeIdentityLabel(cleaned.slice(0, colonIndex)),
        value: cleaned.slice(colonIndex + 1),
      };
}

function stripIdentityValueDecoration(value: string): string {
  let cleaned = value.trim();
  for (;;) {
    const paired = cleaned.match(/^(\*{1,2}|_{1,2}|`+)([\s\S]+)\1$/u);
    const marker = paired?.[1];
    const inner = paired?.[2];
    if (!marker || inner === undefined) {
      return cleaned;
    }
    cleaned = inner.trim();
    // Code spans preserve their contents, including literal emphasis markers.
    if (marker.startsWith("`")) {
      return cleaned;
    }
  }
}

// Mask fenced examples without shifting the line indexes used by identity updates.
function identityLinesOutsideFences(
  content: string,
  regions = findMarkdownCodeRegions(content, { includeIndentedCode: false }).filter(
    (region) => region.block,
  ),
): string[] {
  let regionIndex = 0;
  let offset = 0;
  return content.split("\n").map((line) => {
    let region = regions[regionIndex];
    while (region && offset >= region.end) {
      region = regions[++regionIndex];
    }
    const lineEnd = offset + line.length;
    const outsideCodeBlock = !region || lineEnd <= region.start;
    offset = lineEnd + 1;
    return outsideCodeBlock ? line : "";
  });
}

function parseIdentityMarkdown(content: string): AgentIdentityFile | null {
  return parseIdentityLines(identityLinesOutsideFences(content));
}

function parseIdentityLines(lines: string[]): AgentIdentityFile | null {
  const identity: AgentIdentityFile = {};
  for (const line of lines) {
    const parsed = parseIdentityLine(line);
    if (!parsed) {
      continue;
    }
    const value = stripIdentityValueDecoration(parsed.value);
    if (!value || IDENTITY_PLACEHOLDER_VALUES.has(normalizeIdentityValue(value))) {
      continue;
    }
    if (isRichIdentityLabel(parsed.label)) {
      identity[parsed.label] = value;
    }
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

function resolveIdentityInsertIndex(lines: string[], unfencedLines: string[]): number {
  // New fields stay grouped with existing rich identity fields; otherwise place
  // them directly after the title block so legacy prose remains intact.
  const lastIdentityIndex = unfencedLines.findLastIndex((line) =>
    isRichIdentityLabel(parseIdentityLine(line)?.label ?? ""),
  );
  if (lastIdentityIndex >= 0) {
    return lastIdentityIndex + 1;
  }

  const headingIndex = unfencedLines.findIndex((line) => line.trim().startsWith("#"));
  if (headingIndex === -1) {
    return 0;
  }
  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex]?.trim() === "") {
    insertIndex += 1;
  }
  return insertIndex;
}

type IdentityMarkdownLine = { text: string; originalLine: number };

function identityFenceState(lines: IdentityMarkdownLine[]) {
  const content = lines.map((line) => line.text).join("\n");
  const regions = findMarkdownCodeRegions(content, { includeIndentedCode: false }).filter(
    (region) => region.block,
  );
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.text.length + 1;
  }
  let lineIndex = 0;
  const position = (boundary: number) => {
    while (lineIndex + 1 < offsets.length && offsets[lineIndex + 1]! <= boundary) {
      lineIndex++;
    }
    return { line: lineIndex, column: boundary - offsets[lineIndex]! };
  };
  const protectedLines = new Set<number>();
  const signatures = regions.map(({ start, end }) => {
    const first = position(start);
    // A closing boundary can be the next line start; map its final character.
    const last = position(end - 1);
    const sources = lines.slice(first.line, last.line + 1).map((line) => line.originalLine);
    for (const source of sources) {
      protectedLines.add(source);
    }
    return JSON.stringify([sources, first.column, last.column, content.slice(start, end)]);
  });
  return {
    signatures,
    protectedLines,
    unfencedLines: identityLinesOutsideFences(content, regions),
  };
}

/**
 * Merge writable identity fields while preserving fenced examples and the
 * container boundaries that keep those examples out of identity reads.
 */
export function mergeIdentityMarkdownContent(
  content: string | undefined,
  identity: Pick<AgentIdentityFile, "name" | "theme" | "emoji" | "avatar">,
): string {
  const original = (content || "# IDENTITY.md - Agent Identity\n")
    .replace(/\r\n/g, "\n")
    .replace(/\n*$/, "\n")
    .split("\n")
    .map((text, originalLine) => ({ text, originalLine }));
  const originalState = identityFenceState(original);
  const updates = WRITABLE_IDENTITY_FIELDS.flatMap(([field, label]) => {
    const value = identity[field]?.trim();
    return value ? [{ field, text: "- " + label + ": " + value }] : [];
  });
  const edit = (input: IdentityMarkdownLine[], conservative = false) => {
    const lines = input.map((line) => ({ ...line }));
    const missing: IdentityMarkdownLine[] = [];
    for (const { field, text } of updates) {
      const unfenced = lines.map((line) =>
        originalState.protectedLines.has(line.originalLine) ? "" : line.text,
      );
      const matching = unfenced.flatMap((line, index) =>
        (conservative || line.trim().startsWith("-")) && parseIdentityLine(line)?.label === field
          ? [index]
          : [],
      );
      if (matching.length) {
        for (const index of conservative ? matching : matching.slice(0, 1)) {
          lines[index]!.text = conservative
            ? (lines[index]!.text.match(/^\s*(?:-\s*)?/)?.[0] ?? "") + text.slice(2)
            : text;
        }
        if (!conservative) {
          for (const index of matching.slice(1).toReversed()) {
            lines.splice(index, 1);
          }
        }
      } else if (conservative) {
        missing.push({ text, originalLine: -1 });
      } else {
        const index = resolveIdentityInsertIndex(
          lines.map((line) => line.text),
          unfenced,
        );
        lines.splice(index, 0, { text, originalLine: -1 });
      }
    }
    return missing.length
      ? [...missing, ...["", "<!-- -->", ""].map((text) => ({ text, originalLine: -1 })), ...lines]
      : lines;
  };
  const render = (lines: IdentityMarkdownLine[]) =>
    lines
      .map((line) => line.text)
      .join("\n")
      .replace(/\n*$/, "\n");
  const ordinary = edit(original);
  if (!originalState.signatures.length) {
    return render(ordinary);
  }
  const canonical = updates.map(({ text }) => text);
  const expected = canonical.some((text) => text.includes("\n"))
    ? parseIdentityMarkdown(canonical.join("\n"))
    : parseIdentityLines(canonical);
  const valid = (lines: IdentityMarkdownLine[]) => {
    const state = identityFenceState(lines);
    const actual = parseIdentityLines(state.unfencedLines);
    return (
      state.signatures.length === originalState.signatures.length &&
      state.signatures.every((signature, index) => signature === originalState.signatures[index]) &&
      updates.every(({ field }) => actual?.[field] === expected?.[field])
    );
  };
  if (valid(ordinary)) {
    return render(ordinary);
  }
  // Retain list prefixes and duplicate containers when normalizing them would
  // expose an example or make an unclosed fence consume ordinary prose.
  const conservative = edit(original, true);
  if (!valid(conservative)) {
    throw new Error("Identity update would change fenced Markdown content or field values");
  }
  const normalized = edit(conservative);
  return render(valid(normalized) ? normalized : conservative);
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
  | { kind: "missing" | "too-large" | "invalid-encoding" };

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
      const { size, mtimeMs, ctimeMs } = opened.stat;
      const { dev, ino } = opened.exactIdentity;
      if (size > MAX_IDENTITY_FILE_BYTES) {
        return { kind: "too-large" };
      }
      const revision = JSON.stringify([
        opened.path,
        String(dev),
        String(ino),
        size,
        mtimeMs,
        ctimeMs,
      ]);
      if (revision === input.knownRevision) {
        return { kind: "unchanged" };
      }
      const buffer = readFileDescriptorBoundedSync(opened.fd, MAX_IDENTITY_FILE_BYTES);
      if (!isUtf8(buffer)) {
        return { kind: "invalid-encoding" };
      }
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
  if (result.kind === "invalid-encoding") {
    throw new Error(`Identity file ${identityPath} must be valid UTF-8`);
  }
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
