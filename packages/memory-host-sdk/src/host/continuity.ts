import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseFrontmatterBlock } from "../../../../src/markdown/frontmatter.js";
import { listMemoryFiles } from "./internal.js";

export const RECENT_CONTINUITY_DIR = "memory/recent";
export const RECENT_CONTINUITY_LATEST = `${RECENT_CONTINUITY_DIR}/latest.md`;
export const RECENT_CONTINUITY_SNAPSHOTS_DIR = `${RECENT_CONTINUITY_DIR}/snapshots`;

export type ContinuitySnapshotState = {
  status: string;
  priority: string;
  updatedAt: string;
  supersedes?: string;
  source: string;
  project: string;
  sessionKey: string;
  validUntil: string;
  currentTask: string;
  currentPhase: string;
  latestUserRequest: string;
  blockers: string[];
  nextSteps: string[];
  keyArtifacts: string[];
  conversationSummary?: string;
};

export type ParsedContinuityDocument = {
  title?: string;
  type?: string;
  status?: string;
  priority?: string;
  updatedAt?: string;
  supersedes?: string;
  source?: string;
  project?: string;
  sessionKey?: string;
  validUntil?: string;
  currentTask?: string;
  currentPhase?: string;
  latestUserRequest?: string;
  blockers: string[];
  nextSteps: string[];
  keyArtifacts: string[];
  conversationSummary?: string;
  summary?: string;
};

export type ContinuityManifestEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  status?: string;
  priority?: string;
  updatedAt?: string;
  supersedes?: string;
  type?: string;
  project?: string;
  title?: string;
  summary?: string;
};

const HEAD_MAX_LINES = 30;
const HEAD_MAX_BYTES = 12_000;
const MAX_MANIFEST_FILES = 200;

const STATUS_ORDER: Record<string, number> = {
  active: 0,
  blocked: 1,
  pending: 2,
  stale: 3,
  superseded: 4,
  archived: 5,
  unknown: 6,
};

const PRIORITY_ORDER: Record<string, number> = {
  highest: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

const LEGACY_KEY_ALIASES: Record<string, string> = {
  status: "status",
  状态: "status",
  priority: "priority",
  优先级: "priority",
  updated_at: "updated_at",
  updatedat: "updated_at",
  更新时间: "updated_at",
  supersedes: "supersedes",
  覆盖: "supersedes",
  取代: "supersedes",
  project: "project",
  项目: "project",
  当前项目: "project",
  topic: "topic",
  主题: "topic",
  当前主任务: "current_task",
  current_task: "current_task",
  currenttask: "current_task",
  当前阶段: "current_phase",
  current_phase: "current_phase",
  currentphase: "current_phase",
  当前阻塞: "blockers",
  blockers: "blockers",
  下一步: "next_steps",
  next_steps: "next_steps",
  nextsteps: "next_steps",
  关键文件: "key_artifacts",
  关键产物: "key_artifacts",
  key_artifacts: "key_artifacts",
  keyartifacts: "key_artifacts",
  description: "description",
  目标: "description",
  当前重点: "description",
};

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeList(values: string[]): string[] {
  return values.map((value) => normalizeWhitespace(value)).filter(Boolean);
}

function canonicalizeStatus(raw: string | undefined): string | undefined {
  const value = normalizeWhitespace(raw).toLowerCase();
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "active":
    case "doing":
    case "in_progress":
    case "in-progress":
    case "working":
      return "active";
    case "blocked":
      return "blocked";
    case "pending":
    case "todo":
    case "planned":
      return "pending";
    case "stale":
    case "superseded":
    case "archived":
      return value;
    default:
      return value;
  }
}

function canonicalizePriority(raw: string | undefined): string | undefined {
  const value = normalizeWhitespace(raw).toLowerCase();
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "p0":
    case "highest":
      return "highest";
    case "p1":
    case "high":
      return "high";
    case "p2":
    case "medium":
      return "medium";
    case "p3":
    case "low":
      return "low";
    default:
      return value;
  }
}

function parseTimestampMs(raw: string | undefined, fallback: number): number {
  const value = normalizeWhitespace(raw);
  if (!value) {
    return fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareByContinuityPriority(
  left: Pick<ContinuityManifestEntry, "status" | "priority" | "updatedAt" | "mtimeMs">,
  right: Pick<ContinuityManifestEntry, "status" | "priority" | "updatedAt" | "mtimeMs">,
): number {
  const leftStatus =
    STATUS_ORDER[canonicalizeStatus(left.status) ?? "unknown"] ?? STATUS_ORDER.unknown;
  const rightStatus =
    STATUS_ORDER[canonicalizeStatus(right.status) ?? "unknown"] ?? STATUS_ORDER.unknown;
  if (leftStatus !== rightStatus) {
    return leftStatus - rightStatus;
  }

  const leftPriority =
    PRIORITY_ORDER[canonicalizePriority(left.priority) ?? "unknown"] ?? PRIORITY_ORDER.unknown;
  const rightPriority =
    PRIORITY_ORDER[canonicalizePriority(right.priority) ?? "unknown"] ?? PRIORITY_ORDER.unknown;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftTime = parseTimestampMs(left.updatedAt, left.mtimeMs);
  const rightTime = parseTimestampMs(right.updatedAt, right.mtimeMs);
  return rightTime - leftTime;
}

function readYamlString(map: Record<string, string>, key: string): string | undefined {
  const value = normalizeWhitespace(map[key]);
  return value || undefined;
}

function canonicalizeLegacyKey(label: string): string | undefined {
  const normalized = normalizeWhitespace(label).toLowerCase().replace(/\s+/g, "_");
  return LEGACY_KEY_ALIASES[label] ?? LEGACY_KEY_ALIASES[normalized];
}

function parseLegacyFieldHeader(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.replace(/\r\n/g, "\n").split("\n").slice(0, HEAD_MAX_LINES);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match =
      trimmed.match(/^-+\s*\*\*([^*]+)\*\*\s*[：:]\s*(.+)$/) ??
      trimmed.match(/^-+\s*([^：:]+?)\s*[：:]\s*(.+)$/) ??
      trimmed.match(/^([A-Za-z0-9_\-\u4e00-\u9fff\s]+?)\s*[：:]\s*(.+)$/);
    if (!match) {
      continue;
    }

    const key = canonicalizeLegacyKey(match[1] ?? "");
    const value = normalizeWhitespace(match[2]);
    if (!key || !value) {
      continue;
    }
    result[key] = value;
  }

  return result;
}

function extractHeading(content: string): string | undefined {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match?.[1]) {
      return normalizeWhitespace(match[1]);
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(content: string, title: string): string | undefined {
  const pattern = new RegExp(
    `^##\\s+${escapeRegExp(title)}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    "gim",
  );
  const match = pattern.exec(content);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1].trim();
}

function sectionToList(section: string | undefined): string[] {
  if (!section) {
    return [];
  }
  const lines = section
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  const normalized = normalizeList(lines);
  if (normalized.length === 1 && normalized[0]?.toLowerCase() === "none") {
    return [];
  }
  return normalized;
}

function firstOfList(section: string | undefined): string | undefined {
  const list = sectionToList(section);
  return list[0];
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }
  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return normalized;
  }
  return normalized.slice(endIndex + 5);
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function readHead(absPath: string, maxLines: number, maxBytes: number): Promise<string> {
  const handle = await fs.open(absPath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer
      .subarray(0, bytesRead)
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .slice(0, maxLines)
      .join("\n");
  } finally {
    await handle.close();
  }
}

function pickSummary(
  fields: ParsedContinuityDocument,
  legacy: Record<string, string>,
): string | undefined {
  return (
    truncateText(fields.currentTask, 180) ??
    truncateText(fields.currentPhase, 180) ??
    truncateText(fields.latestUserRequest, 180) ??
    truncateText(legacy.description, 180) ??
    truncateText(legacy.topic, 180) ??
    truncateText(fields.title, 180)
  );
}

export function parseContinuityDocument(content: string): ParsedContinuityDocument {
  const frontmatter = parseFrontmatterBlock(content);
  const legacy = parseLegacyFieldHeader(stripFrontmatter(content));
  const heading = extractHeading(stripFrontmatter(content));

  const blockers =
    sectionToList(extractSection(content, "Current Blockers")) ??
    sectionToList(extractSection(content, "Blockers"));
  const nextSteps =
    sectionToList(extractSection(content, "Next Steps")) ??
    sectionToList(extractSection(content, "Next Step"));
  const keyArtifacts = sectionToList(extractSection(content, "Key Artifacts"));

  const parsed: ParsedContinuityDocument = {
    title: heading ?? readYamlString(frontmatter, "title"),
    type: readYamlString(frontmatter, "type"),
    status: canonicalizeStatus(readYamlString(frontmatter, "status") ?? legacy.status),
    priority: canonicalizePriority(readYamlString(frontmatter, "priority") ?? legacy.priority),
    updatedAt: readYamlString(frontmatter, "updated_at") ?? legacy.updated_at,
    supersedes: readYamlString(frontmatter, "supersedes") ?? legacy.supersedes,
    source: readYamlString(frontmatter, "source"),
    project: readYamlString(frontmatter, "project") ?? legacy.project,
    sessionKey: readYamlString(frontmatter, "session_key"),
    validUntil: readYamlString(frontmatter, "valid_until"),
    currentTask:
      firstOfList(extractSection(content, "Current Task")) ??
      readYamlString(frontmatter, "current_task") ??
      legacy.current_task,
    currentPhase:
      firstOfList(extractSection(content, "Current Phase")) ??
      readYamlString(frontmatter, "current_phase") ??
      legacy.current_phase,
    latestUserRequest:
      firstOfList(extractSection(content, "Latest User Request")) ??
      readYamlString(frontmatter, "latest_user_request"),
    blockers:
      blockers.length > 0 ? blockers : normalizeList((legacy.blockers ?? "").split(/[；;]+/g)),
    nextSteps:
      nextSteps.length > 0 ? nextSteps : normalizeList((legacy.next_steps ?? "").split(/[；;]+/g)),
    keyArtifacts:
      keyArtifacts.length > 0
        ? keyArtifacts
        : normalizeList((legacy.key_artifacts ?? "").split(/[；;]+/g)),
    conversationSummary:
      extractSection(content, "Conversation Summary") ??
      readYamlString(frontmatter, "conversation_summary"),
    summary: undefined,
  };

  parsed.summary = pickSummary(parsed, legacy);
  return parsed;
}

export function hasMaterialContinuityChange(
  previousContent: string | undefined,
  nextState: ContinuitySnapshotState,
): boolean {
  if (!previousContent) {
    return true;
  }
  const previous = parseContinuityDocument(previousContent);
  const canonicalPrevious = JSON.stringify({
    status: canonicalizeStatus(previous.status),
    priority: canonicalizePriority(previous.priority),
    project: normalizeWhitespace(previous.project),
    currentTask: normalizeWhitespace(previous.currentTask),
    currentPhase: normalizeWhitespace(previous.currentPhase),
    latestUserRequest: normalizeWhitespace(previous.latestUserRequest),
    blockers: normalizeList(previous.blockers),
    nextSteps: normalizeList(previous.nextSteps),
    keyArtifacts: normalizeList(previous.keyArtifacts),
  });
  const canonicalNext = JSON.stringify({
    status: canonicalizeStatus(nextState.status),
    priority: canonicalizePriority(nextState.priority),
    project: normalizeWhitespace(nextState.project),
    currentTask: normalizeWhitespace(nextState.currentTask),
    currentPhase: normalizeWhitespace(nextState.currentPhase),
    latestUserRequest: normalizeWhitespace(nextState.latestUserRequest),
    blockers: normalizeList(nextState.blockers),
    nextSteps: normalizeList(nextState.nextSteps),
    keyArtifacts: normalizeList(nextState.keyArtifacts),
  });
  return canonicalPrevious !== canonicalNext;
}

export function renderContinuitySnapshotMarkdown(state: ContinuitySnapshotState): string {
  const frontmatter = YAML.stringify({
    type: "recent_snapshot",
    status: state.status,
    priority: state.priority,
    updated_at: state.updatedAt,
    supersedes: state.supersedes,
    source: state.source,
    project: state.project,
    session_key: state.sessionKey,
    valid_until: state.validUntil,
  }).trimEnd();

  const lines = [
    "---",
    frontmatter,
    "---",
    "",
    "# Recent Continuity Snapshot",
    "",
    "## Current Task",
    `- ${state.currentTask || "unknown"}`,
    "",
    "## Current Phase",
    `- ${state.currentPhase || "unknown"}`,
    "",
    "## Latest User Request",
    `- ${state.latestUserRequest || "unknown"}`,
    "",
    "## Current Blockers",
    ...(state.blockers.length > 0 ? state.blockers.map((entry) => `- ${entry}`) : ["- none"]),
    "",
    "## Next Steps",
    ...(state.nextSteps.length > 0 ? state.nextSteps.map((entry) => `- ${entry}`) : ["- none"]),
    "",
    "## Key Artifacts",
    ...(state.keyArtifacts.length > 0
      ? state.keyArtifacts.map((entry) => `- ${entry}`)
      : ["- none"]),
  ];

  if (normalizeWhitespace(state.conversationSummary)) {
    lines.push("", "## Conversation Summary", "", normalizeWhitespace(state.conversationSummary));
  }

  return `${lines.join("\n")}\n`;
}

export async function readRecentContinuitySnapshot(workspaceDir: string): Promise<{
  path: string;
  content: string;
} | null> {
  const latestPath = path.join(workspaceDir, RECENT_CONTINUITY_LATEST);
  try {
    const content = await fs.readFile(latestPath, "utf-8");
    return {
      path: RECENT_CONTINUITY_LATEST,
      content,
    };
  } catch {}

  const snapshotsDir = path.join(workspaceDir, RECENT_CONTINUITY_SNAPSHOTS_DIR);
  try {
    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const absPath = path.join(snapshotsDir, entry.name);
          const stat = await fs.stat(absPath);
          return { absPath, mtimeMs: stat.mtimeMs };
        }),
    );
    const latest = files.toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!latest) {
      return null;
    }
    const content = await fs.readFile(latest.absPath, "utf-8");
    return {
      path: path.relative(workspaceDir, latest.absPath).replace(/\\/g, "/"),
      content,
    };
  } catch {
    return null;
  }
}

export async function buildContinuityManifest(params: {
  workspaceDir: string;
  extraPaths?: string[];
  maxFiles?: number;
}): Promise<ContinuityManifestEntry[]> {
  const files = await listMemoryFiles(params.workspaceDir, params.extraPaths);
  const statEntries = await Promise.all(
    files.map(async (absPath) => {
      try {
        const stat = await fs.stat(absPath);
        return { absPath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const selected = statEntries
    .filter((entry): entry is { absPath: string; mtimeMs: number } => Boolean(entry))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, params.maxFiles ?? MAX_MANIFEST_FILES);

  const parsed = await Promise.all(
    selected.map(async ({ absPath, mtimeMs }) => {
      try {
        const head = await readHead(absPath, HEAD_MAX_LINES, HEAD_MAX_BYTES);
        const doc = parseContinuityDocument(head);
        return {
          path: path.relative(params.workspaceDir, absPath).replace(/\\/g, "/"),
          absPath,
          mtimeMs,
          status: doc.status,
          priority: doc.priority,
          updatedAt: doc.updatedAt,
          supersedes: doc.supersedes,
          type: doc.type,
          project: doc.project,
          title: doc.title,
          summary: doc.summary,
        } satisfies ContinuityManifestEntry;
      } catch {
        return null;
      }
    }),
  );

  const manifestEntries: ContinuityManifestEntry[] = [];
  for (const entry of parsed) {
    if (entry) {
      manifestEntries.push(entry);
    }
  }
  return manifestEntries.toSorted(compareByContinuityPriority);
}

export function formatContinuityManifest(
  entries: ContinuityManifestEntry[],
  maxEntries: number = 5,
): string {
  const limited = entries.slice(0, maxEntries);
  if (limited.length === 0) {
    return "";
  }
  const lines = limited.map((entry) => {
    const status = canonicalizeStatus(entry.status) ?? "unknown";
    const priority = canonicalizePriority(entry.priority) ?? "unknown";
    const stamp = normalizeWhitespace(entry.updatedAt) || new Date(entry.mtimeMs).toISOString();
    const summary = truncateText(entry.summary ?? entry.title, 180) ?? "no summary";
    return `- [${status}/${priority}] ${entry.path} (${stamp}): ${summary}`;
  });
  return `<continuity-manifest>\n${lines.join("\n")}\n</continuity-manifest>`;
}

export function formatContinuitySnapshotForPrompt(
  content: string,
  maxChars: number = 1200,
): string {
  const parsed = parseContinuityDocument(content);
  const lines: string[] = [];
  if (parsed.project) {
    lines.push(`Project: ${parsed.project}`);
  }
  if (parsed.currentTask) {
    lines.push(`Current task: ${parsed.currentTask}`);
  }
  if (parsed.currentPhase) {
    lines.push(`Current phase: ${parsed.currentPhase}`);
  }
  if (parsed.latestUserRequest) {
    lines.push(`Latest user request: ${parsed.latestUserRequest}`);
  }
  if (parsed.blockers.length > 0) {
    lines.push(`Blockers: ${parsed.blockers.join(" | ")}`);
  }
  if (parsed.nextSteps.length > 0) {
    lines.push(`Next steps: ${parsed.nextSteps.join(" | ")}`);
  }
  if (parsed.keyArtifacts.length > 0) {
    lines.push(`Key artifacts: ${parsed.keyArtifacts.join(" | ")}`);
  }
  if (parsed.conversationSummary) {
    lines.push(`Conversation summary: ${normalizeWhitespace(parsed.conversationSummary)}`);
  }
  const text = lines.join("\n").trim();
  if (!text) {
    return "";
  }
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
