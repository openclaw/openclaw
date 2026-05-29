import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  formatMemoryDreamingDay,
  resolveMemoryDreamingWorkspaces,
} from "openclaw/plugin-sdk/memory-core-host-status";
import {
  resolveSessionFilePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { loadCombinedSessionStoreForGateway } from "openclaw/plugin-sdk/session-transcript-hit";

export const MEMORY_AUDIT_SUGGESTIONS_RELATIVE_PATH = "memory/audit/suggestions.jsonl";
export const MEMORY_AUDIT_REPORTS_RELATIVE_DIR = "memory/audit/reports";

export type MemoryAuditAction = "add" | "edit" | "delete" | "move";
export type MemoryAuditSurfaceKind =
  | "agent-instructions"
  | "agent-memory"
  | "user-profile"
  | "tool-notes"
  | "shared-memory"
  | "daily-memory"
  | "session-log";
export type MemoryAuditSuggestionStatus = "pending" | "applied" | "rejected" | "conflict";

export type MemoryAuditSurface = {
  id: string;
  kind: MemoryAuditSurfaceKind;
  label: string;
  workspaceDir: string;
  path: string;
  agentId?: string;
  writable: boolean;
  exists: boolean;
  lineCount: number;
  updatedAtMs?: number;
};

export type MemoryAuditBlock = {
  surface: MemoryAuditSurface;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export type MemoryAuditSuggestionTarget = {
  surfaceId: string;
  kind: MemoryAuditSurfaceKind;
  path: string;
  workspaceDir: string;
  agentId?: string;
};

export type MemoryAuditSuggestion = {
  id: string;
  status: MemoryAuditSuggestionStatus;
  action: MemoryAuditAction;
  text: string;
  rationale: string;
  confidence: number;
  source?: MemoryAuditSuggestionTarget & {
    startLine: number;
    endLine: number;
    hash: string;
  };
  target: MemoryAuditSuggestionTarget;
  reviewerAgentId?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  rejectedAt?: string;
  conflict?: string;
};

export type MemoryAuditSuggestionSummary = {
  total: number;
  pending: number;
  applied: number;
  rejected: number;
  conflict: number;
  suggestions: MemoryAuditSuggestion[];
};

export type MemoryAuditCollectResult = {
  auditAgentId?: string;
  cadence?: "daily" | "weekly" | "manual";
  surfaces: MemoryAuditSurface[];
  blocks: MemoryAuditBlock[];
  pendingSuggestions: number;
};

type StageInput = {
  action: MemoryAuditAction;
  text?: string;
  rationale?: string;
  confidence?: number;
  source?: {
    surfaceId: string;
    startLine: number;
    endLine: number;
    hash?: string;
  };
  target?: {
    surfaceId?: string;
    kind?: MemoryAuditSurfaceKind;
    agentId?: string;
    path?: string;
    workspaceDir?: string;
  };
};

const DEFAULT_BLOCK_LIMIT = 60;
const MAX_BLOCK_LIMIT = 200;
const MAX_LINES_PER_BLOCK = 8;
const MAX_DAILY_MEMORY_SURFACES = 14;
const MAX_SESSION_LOG_SURFACES = 20;
const WRITABLE_SURFACE_PATHS: Readonly<
  Record<Exclude<MemoryAuditSurfaceKind, "shared-memory" | "daily-memory" | "session-log">, string>
> = {
  "agent-instructions": "AGENTS.md",
  "agent-memory": "MEMORY.md",
  "user-profile": "USER.md",
  "tool-notes": "TOOLS.md",
};

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function normalizeAction(value: unknown): MemoryAuditAction | undefined {
  return value === "add" || value === "edit" || value === "delete" || value === "move"
    ? value
    : undefined;
}

function normalizeKind(value: unknown): MemoryAuditSurfaceKind | undefined {
  return value === "agent-instructions" ||
    value === "agent-memory" ||
    value === "user-profile" ||
    value === "tool-notes" ||
    value === "shared-memory" ||
    value === "daily-memory" ||
    value === "session-log"
    ? value
    : undefined;
}

function isWritableSurfaceKind(kind: MemoryAuditSurfaceKind): boolean {
  return kind !== "daily-memory" && kind !== "session-log";
}

function clampConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.7;
  }
  return Math.max(0, Math.min(1, number));
}

function normalizeMarkdownLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeRelativeMarkdownPath(value: string | undefined, fallback: string): string {
  const input = value?.trim() || fallback;
  const normalized = input.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !normalized.toLowerCase().endsWith(".md")
  ) {
    throw new Error("memory audit target path must be a relative Markdown file path");
  }
  return normalized;
}

function suggestionStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_AUDIT_SUGGESTIONS_RELATIVE_PATH);
}

function reportPath(workspaceDir: string, day: string): string {
  return path.join(workspaceDir, MEMORY_AUDIT_REPORTS_RELATIVE_DIR, `${day}.md`);
}

function surfaceId(params: {
  workspaceDir: string;
  kind: MemoryAuditSurfaceKind;
  path: string;
  agentId?: string;
}): string {
  return hashText([params.workspaceDir, params.kind, params.path, params.agentId ?? ""].join("\0"));
}

async function statTextFile(filePath: string): Promise<{
  exists: boolean;
  text: string;
  lineCount: number;
  updatedAtMs?: number;
}> {
  const stat = await fs.stat(filePath).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat || !stat.isFile()) {
    return { exists: false, text: "", lineCount: 0 };
  }
  const text = await fs.readFile(filePath, "utf8");
  return {
    exists: true,
    text,
    lineCount: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    updatedAtMs: stat.mtimeMs,
  };
}

function targetFromSurface(surface: MemoryAuditSurface): MemoryAuditSuggestionTarget {
  return {
    surfaceId: surface.id,
    kind: surface.kind,
    path: surface.path,
    workspaceDir: surface.workspaceDir,
    ...(surface.agentId ? { agentId: surface.agentId } : {}),
  };
}

function buildSurface(params: {
  kind: MemoryAuditSurfaceKind;
  workspaceDir: string;
  path: string;
  label: string;
  agentId?: string;
  writable?: boolean;
  stat: Awaited<ReturnType<typeof statTextFile>>;
}): MemoryAuditSurface {
  return {
    id: surfaceId(params),
    kind: params.kind,
    label: params.label,
    workspaceDir: params.workspaceDir,
    path: params.path,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    writable: params.writable ?? isWritableSurfaceKind(params.kind),
    exists: params.stat.exists,
    lineCount: params.stat.lineCount,
    updatedAtMs: params.stat.updatedAtMs,
  };
}

async function collectDailyMemorySurfaces(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryAuditSurface[]> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map(async (entry) => {
        const relPath = `memory/${entry.name}`;
        const stat = await statTextFile(path.join(params.workspaceDir, relPath));
        return { relPath, stat };
      }),
  );
  return candidates
    .filter((candidate) => candidate.stat.exists)
    .toSorted((a, b) => (b.stat.updatedAtMs ?? 0) - (a.stat.updatedAtMs ?? 0))
    .slice(0, MAX_DAILY_MEMORY_SURFACES)
    .map(({ relPath, stat }) =>
      buildSurface({
        kind: "daily-memory",
        workspaceDir: params.workspaceDir,
        path: relPath,
        label: `daily ${relPath}`,
        agentId: params.agentIds.length === 1 ? params.agentIds[0] : undefined,
        writable: false,
        stat,
      }),
    );
}

function extractTranscriptText(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("message" in parsed)) {
    return null;
  }
  const message = (parsed as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const value =
        (part as { text?: unknown; content?: unknown }).text ??
        (part as { text?: unknown; content?: unknown }).content;
      return typeof value === "string" ? value.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

function buildBlocksForSessionSurface(
  surface: MemoryAuditSurface,
  text: string,
): MemoryAuditBlock[] {
  const blocks: MemoryAuditBlock[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const selected = extractTranscriptText(line);
    if (!selected) {
      continue;
    }
    blocks.push({
      surface,
      startLine: index + 1,
      endLine: index + 1,
      text: selected,
      hash: hashText(selected),
    });
  }
  return blocks;
}

async function collectSessionLogSurfaces(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemoryAuditSurface[]> {
  const { store, storePath } = loadCombinedSessionStoreForGateway(params.cfg, {
    agentId: params.agentId,
  });
  const sessionsDir = storePath === "(multiple)" ? undefined : path.dirname(storePath);
  const seenFiles = new Set<string>();
  const candidates: Array<{
    key: string;
    entry: SessionEntry;
    filePath: string;
  }> = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!entry.sessionId) {
      continue;
    }
    const ownerAgentId = resolveSessionAgentId({ sessionKey: key, config: params.cfg });
    if (ownerAgentId !== params.agentId) {
      continue;
    }
    const filePath = resolveSessionFilePath(entry.sessionId, entry, {
      agentId: params.agentId,
      ...(sessionsDir ? { sessionsDir } : {}),
    });
    if (seenFiles.has(filePath)) {
      continue;
    }
    seenFiles.add(filePath);
    candidates.push({ key, entry, filePath });
  }
  const newest = candidates
    .toSorted((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))
    .slice(0, MAX_SESSION_LOG_SURFACES);
  const surfaces: MemoryAuditSurface[] = [];
  for (const candidate of newest) {
    const stat = await statTextFile(candidate.filePath);
    if (!stat.exists) {
      continue;
    }
    surfaces.push(
      buildSurface({
        kind: "session-log",
        workspaceDir: path.dirname(candidate.filePath),
        path: path.basename(candidate.filePath),
        label: `${params.agentId} session ${candidate.key}`,
        agentId: params.agentId,
        writable: false,
        stat,
      }),
    );
  }
  return surfaces;
}

export async function collectMemoryAuditSurfaces(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryAuditSurface[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  const surfaces: MemoryAuditSurface[] = [];
  for (const workspace of workspaces) {
    for (const agentId of workspace.agentIds) {
      const agentWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
      for (const kind of [
        "agent-instructions",
        "agent-memory",
        "user-profile",
        "tool-notes",
      ] as const) {
        const relPath = WRITABLE_SURFACE_PATHS[kind];
        const fileStat = await statTextFile(path.join(agentWorkspaceDir, relPath));
        surfaces.push(
          buildSurface({
            kind,
            workspaceDir: agentWorkspaceDir,
            path: relPath,
            agentId,
            label: `${agentId} ${relPath}`,
            stat: fileStat,
          }),
        );
      }
      surfaces.push(...(await collectSessionLogSurfaces({ cfg: params.cfg, agentId })));
    }
    surfaces.push(
      ...(await collectDailyMemorySurfaces({
        workspaceDir: workspace.workspaceDir,
        agentIds: workspace.agentIds,
      })),
    );
  }
  const primary = workspaces[0]?.workspaceDir;
  if (primary) {
    const relPath = "shared-memory.md";
    const fileStat = await statTextFile(path.join(primary, relPath));
    surfaces.push(
      buildSurface({
        kind: "shared-memory",
        workspaceDir: primary,
        path: relPath,
        label: relPath,
        stat: fileStat,
      }),
    );
  }
  return surfaces.toSorted((a, b) => {
    if (a.writable !== b.writable) {
      return a.writable ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
}

function buildBlocksForSurface(surface: MemoryAuditSurface, text: string): MemoryAuditBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: MemoryAuditBlock[] = [];
  let start = 0;
  for (let index = 0; index <= lines.length; index += 1) {
    const isBoundary = index === lines.length || lines[index]?.trim() === "";
    if (!isBoundary) {
      continue;
    }
    if (index > start) {
      const end = Math.min(index, start + MAX_LINES_PER_BLOCK);
      const selected = lines.slice(start, end).join("\n").trim();
      if (selected.length > 0) {
        blocks.push({
          surface,
          startLine: start + 1,
          endLine: end,
          text: selected,
          hash: hashText(selected),
        });
      }
    }
    start = index + 1;
  }
  return blocks;
}

export async function collectMemoryAuditContext(params: {
  cfg: OpenClawConfig;
  auditAgentId?: string;
  cadence?: "daily" | "weekly" | "manual";
  limit?: number;
}): Promise<MemoryAuditCollectResult> {
  const surfaces = await collectMemoryAuditSurfaces({ cfg: params.cfg });
  const blocks: MemoryAuditBlock[] = [];
  const limit = Math.max(
    1,
    Math.min(MAX_BLOCK_LIMIT, Math.floor(params.limit ?? DEFAULT_BLOCK_LIMIT)),
  );
  for (const surface of surfaces) {
    if (!surface.exists) {
      continue;
    }
    const text = await fs.readFile(path.join(surface.workspaceDir, surface.path), "utf8");
    blocks.push(
      ...(surface.kind === "session-log"
        ? buildBlocksForSessionSurface(surface, text)
        : buildBlocksForSurface(surface, text)),
    );
    if (blocks.length >= limit) {
      break;
    }
  }
  const summaries = await Promise.all(
    [
      ...new Set(
        surfaces.filter((surface) => surface.writable).map((surface) => surface.workspaceDir),
      ),
    ].map((workspaceDir) => readMemoryAuditSuggestions({ workspaceDir })),
  );
  return {
    auditAgentId: params.auditAgentId,
    cadence: params.cadence,
    surfaces,
    blocks: blocks.slice(0, limit),
    pendingSuggestions: summaries.reduce((sum, summary) => sum + summary.pending, 0),
  };
}

function parseSuggestionRecord(line: string): MemoryAuditSuggestion | null {
  try {
    const parsed = JSON.parse(line) as Partial<MemoryAuditSuggestion>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.action !== "string" ||
      typeof parsed.text !== "string" ||
      !parsed.target
    ) {
      return null;
    }
    return parsed as MemoryAuditSuggestion;
  } catch {
    return null;
  }
}

async function appendSuggestion(workspaceDir: string, suggestion: MemoryAuditSuggestion) {
  const storePath = suggestionStorePath(workspaceDir);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.appendFile(storePath, `${JSON.stringify(suggestion)}\n`, "utf8");
}

export async function readMemoryAuditSuggestions(params: {
  workspaceDir: string;
}): Promise<MemoryAuditSuggestionSummary> {
  const storePath = suggestionStorePath(params.workspaceDir);
  const content = await fs.readFile(storePath, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
  const byId = new Map<string, MemoryAuditSuggestion>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const record = parseSuggestionRecord(trimmed);
    if (record) {
      byId.set(record.id, record);
    }
  }
  const suggestions = [...byId.values()].toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  return {
    total: suggestions.length,
    pending: suggestions.filter((entry) => entry.status === "pending").length,
    applied: suggestions.filter((entry) => entry.status === "applied").length,
    rejected: suggestions.filter((entry) => entry.status === "rejected").length,
    conflict: suggestions.filter((entry) => entry.status === "conflict").length,
    suggestions,
  };
}

function resolveTarget(params: {
  surfaces: MemoryAuditSurface[];
  input?: StageInput["target"];
  sourceSurface?: MemoryAuditSurface;
}): MemoryAuditSuggestionTarget {
  const byId = params.input?.surfaceId
    ? params.surfaces.find((surface) => surface.id === params.input?.surfaceId)
    : undefined;
  if (byId) {
    if (!byId.writable) {
      throw new Error("memory audit target must be a writable memory surface");
    }
    return targetFromSurface(byId);
  }
  const kind = normalizeKind(params.input?.kind) ?? params.sourceSurface?.kind ?? "agent-memory";
  const agentId = params.input?.agentId ?? params.sourceSurface?.agentId;
  const workspaceDir =
    params.input?.workspaceDir ??
    (agentId
      ? params.surfaces.find((surface) => surface.agentId === agentId)?.workspaceDir
      : params.sourceSurface?.workspaceDir) ??
    params.surfaces[0]?.workspaceDir;
  if (!workspaceDir) {
    throw new Error("memory audit target workspace unavailable");
  }
  const fallbackPath =
    kind === "agent-instructions"
      ? "AGENTS.md"
      : kind === "user-profile"
        ? "USER.md"
        : kind === "tool-notes"
          ? "TOOLS.md"
          : kind === "shared-memory"
            ? "shared-memory.md"
            : "MEMORY.md";
  if (!isWritableSurfaceKind(kind)) {
    throw new Error("memory audit target must be a writable memory surface");
  }
  const relPath = normalizeRelativeMarkdownPath(params.input?.path, fallbackPath);
  return {
    surfaceId: surfaceId({ workspaceDir, kind, path: relPath, agentId }),
    kind,
    path: relPath,
    workspaceDir,
    ...(agentId ? { agentId } : {}),
  };
}

function buildSuggestionId(params: {
  action: MemoryAuditAction;
  sourceKey: string;
  target: MemoryAuditSuggestionTarget;
  text: string;
}): string {
  return `ma_${hashText(
    [
      params.action,
      params.sourceKey,
      params.target.surfaceId,
      params.target.path,
      params.text,
    ].join("\0"),
  )}`;
}

export async function stageMemoryAuditSuggestions(params: {
  cfg: OpenClawConfig;
  reviewerAgentId?: string;
  suggestions: StageInput[];
  nowMs?: number;
}): Promise<MemoryAuditSuggestionSummary> {
  const surfaces = await collectMemoryAuditSurfaces({ cfg: params.cfg });
  const now = new Date(params.nowMs ?? Date.now()).toISOString();
  let lastWorkspaceDir =
    surfaces[0]?.workspaceDir ??
    resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  for (const input of params.suggestions) {
    const action = normalizeAction(input.action);
    if (!action) {
      continue;
    }
    const sourceSurface = input.source
      ? surfaces.find((surface) => surface.id === input.source?.surfaceId)
      : undefined;
    if (action !== "add" && !sourceSurface) {
      continue;
    }
    if (sourceSurface && !sourceSurface.writable && action !== "add") {
      throw new Error("memory audit can only add recommendations from read-only evidence surfaces");
    }
    const text = normalizeMarkdownLine(input.text ?? "");
    if ((action === "add" || action === "edit" || action === "move") && !text) {
      continue;
    }
    const target = resolveTarget({ surfaces, input: input.target, sourceSurface });
    lastWorkspaceDir = target.workspaceDir;
    const source =
      input.source && sourceSurface
        ? {
            ...targetFromSurface(sourceSurface),
            startLine: Math.max(1, Math.floor(input.source.startLine)),
            endLine: Math.max(1, Math.floor(input.source.endLine)),
            hash: input.source.hash ?? "",
          }
        : undefined;
    const sourceKey = source
      ? `${source.surfaceId}:${source.startLine}-${source.endLine}:${source.hash}`
      : hashText(text);
    const id = buildSuggestionId({ action, sourceKey, target, text });
    const existing = await readMemoryAuditSuggestions({ workspaceDir: target.workspaceDir });
    if (existing.suggestions.some((entry) => entry.id === id && entry.status === "pending")) {
      continue;
    }
    await appendSuggestion(target.workspaceDir, {
      id,
      status: "pending",
      action,
      text,
      rationale: input.rationale?.trim() || "Memory audit recommendation.",
      confidence: clampConfidence(input.confidence),
      ...(source ? { source } : {}),
      target,
      ...(params.reviewerAgentId ? { reviewerAgentId: params.reviewerAgentId } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  return await readMemoryAuditSuggestions({ workspaceDir: lastWorkspaceDir });
}

function readRangeHash(lines: string[], startLine: number, endLine: number): string {
  return hashText(
    lines
      .slice(startLine - 1, endLine)
      .join("\n")
      .trim(),
  );
}

async function appendToTarget(target: MemoryAuditSuggestionTarget, text: string) {
  if (!isWritableSurfaceKind(target.kind)) {
    throw new Error("memory audit target must be a writable memory surface");
  }
  const targetPath = path.join(target.workspaceDir, target.path);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const existing = await fs.readFile(targetPath, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
  const prefix = existing.trim().length > 0 ? `${existing.replace(/\s+$/u, "")}\n\n` : "";
  await fs.writeFile(targetPath, `${prefix}${text.trim()}\n`, "utf8");
}

async function replaceSourceRange(params: {
  source: NonNullable<MemoryAuditSuggestion["source"]>;
  replacement?: string;
}): Promise<{ ok: true } | { ok: false; conflict: string }> {
  const sourcePath = path.join(params.source.workspaceDir, params.source.path);
  const content = await fs.readFile(sourcePath, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (content === null) {
    return { ok: false, conflict: "source file missing" };
  }
  const lines = content.split(/\r?\n/);
  if (
    params.source.startLine < 1 ||
    params.source.endLine < params.source.startLine ||
    params.source.endLine > lines.length
  ) {
    return { ok: false, conflict: "source range no longer exists" };
  }
  const currentHash = readRangeHash(lines, params.source.startLine, params.source.endLine);
  if (params.source.hash && currentHash !== params.source.hash) {
    return { ok: false, conflict: "source range changed since recommendation was staged" };
  }
  const replacementLines = params.replacement ? params.replacement.trim().split(/\r?\n/) : [];
  const nextLines = [
    ...lines.slice(0, params.source.startLine - 1),
    ...replacementLines,
    ...lines.slice(params.source.endLine),
  ];
  await fs.writeFile(sourcePath, `${nextLines.join("\n").replace(/\s+$/u, "")}\n`, "utf8");
  return { ok: true };
}

async function appendStatus(params: {
  suggestion: MemoryAuditSuggestion;
  status: MemoryAuditSuggestionStatus;
  conflict?: string;
}) {
  const now = new Date().toISOString();
  await appendSuggestion(params.suggestion.target.workspaceDir, {
    ...params.suggestion,
    status: params.status,
    updatedAt: now,
    ...(params.status === "applied" ? { appliedAt: now } : {}),
    ...(params.status === "rejected" ? { rejectedAt: now } : {}),
    ...(params.conflict ? { conflict: params.conflict } : {}),
  });
}

export async function applyMemoryAuditSuggestion(params: {
  workspaceDir: string;
  id: string;
}): Promise<{ applied: boolean; suggestion?: MemoryAuditSuggestion; conflict?: string }> {
  const summary = await readMemoryAuditSuggestions({ workspaceDir: params.workspaceDir });
  const suggestion = summary.suggestions.find((entry) => entry.id === params.id);
  if (!suggestion) {
    throw new Error(`memory audit suggestion not found: ${params.id}`);
  }
  if (suggestion.status !== "pending") {
    return { applied: false, suggestion, conflict: `suggestion is ${suggestion.status}` };
  }
  if (suggestion.action === "add") {
    await appendToTarget(suggestion.target, suggestion.text);
    await appendStatus({ suggestion, status: "applied" });
    return { applied: true, suggestion };
  }
  if (!suggestion.source) {
    await appendStatus({ suggestion, status: "conflict", conflict: "source range missing" });
    return { applied: false, suggestion, conflict: "source range missing" };
  }
  const replacement = suggestion.action === "edit" ? suggestion.text : undefined;
  const sourceResult = await replaceSourceRange({
    source: suggestion.source,
    replacement,
  });
  if (!sourceResult.ok) {
    await appendStatus({ suggestion, status: "conflict", conflict: sourceResult.conflict });
    return { applied: false, suggestion, conflict: sourceResult.conflict };
  }
  if (suggestion.action === "move") {
    await appendToTarget(suggestion.target, suggestion.text);
  }
  await appendStatus({ suggestion, status: "applied" });
  return { applied: true, suggestion };
}

export async function rejectMemoryAuditSuggestion(params: {
  workspaceDir: string;
  id: string;
}): Promise<{ rejected: boolean; suggestion?: MemoryAuditSuggestion }> {
  const summary = await readMemoryAuditSuggestions({ workspaceDir: params.workspaceDir });
  const suggestion = summary.suggestions.find((entry) => entry.id === params.id);
  if (!suggestion) {
    throw new Error(`memory audit suggestion not found: ${params.id}`);
  }
  if (suggestion.status !== "pending") {
    return { rejected: false, suggestion };
  }
  await appendStatus({ suggestion, status: "rejected" });
  return { rejected: true, suggestion };
}

export async function writeMemoryAuditReport(params: {
  workspaceDir: string;
  bodyLines: string[];
  nowMs?: number;
  timezone?: string;
}) {
  const day = formatMemoryDreamingDay(params.nowMs ?? Date.now(), params.timezone);
  const output = reportPath(params.workspaceDir, day);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    [`# Memory Audit ${day}`, "", ...params.bodyLines, ""].join("\n"),
    "utf8",
  );
  return { path: output };
}
