import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
  type SessionFileEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { asRecord } from "./dreaming-shared.js";

const DEFAULT_ROLLUP_SCHEMA = "session-rollup-v1";
const DEFAULT_ROLLUP_DIR = "memory/session-rollups";
const DEFAULT_MAX_MESSAGES = 80;
const DEFAULT_MAX_SUMMARY_CHARS = 1800;
const DEFAULT_REDACT_SECRETS = true;
const SOURCE_STALE_WARNING_RATIO = 0.25;

export type MemoryRollupConfig = {
  enabled: boolean;
  outputDir: string;
  maxMessages: number;
  maxSummaryChars: number;
  redactSecrets: boolean;
};

export type SessionRollupAction = {
  sourcePath: string;
  outputPath: string;
  sourceTranscript: string;
  status: "missing" | "upToDate" | "stale";
  inputHash: string;
  outputHash?: string;
  outputCreated: boolean;
  outputUpdated: boolean;
  generated: boolean;
  reason?: string;
};

export type SessionRollupOrphan = {
  outputPath: string;
  reason: "orphan" | "unparseable";
  sourceTranscript?: string;
};

export type SessionRollupPlan = {
  config: MemoryRollupConfig;
  discovered: number;
  generated: number;
  pending: number;
  stale: number;
  orphaned: number;
  actions: SessionRollupAction[];
  orphans: SessionRollupOrphan[];
  evidenceCoveragePercent: number;
};

export type SessionRollupSummaryLine = {
  sourceTranscript: string;
  sessionId: string;
  startAt: string;
  endAt: string;
  messageCount: number;
  inputHash: string;
  rollupSchema: string;
};

export type SessionRollupGenerationResult = SessionRollupPlan & {
  wrote: number;
  unchanged: number;
  skipped: number;
};

function summarizeRollupActions(actions: SessionRollupAction[]): {
  generated: number;
  pending: number;
  stale: number;
  evidenceCoveragePercent: number;
} {
  const generated = actions.filter((action) => action.status === "upToDate").length;
  const stale = actions.filter((action) => action.status === "stale").length;
  const pending = actions.filter((action) => action.status === "missing").length;
  const discovered = actions.length;
  const evidenceCoveragePercent =
    discovered === 0 ? 100 : Math.round((generated / discovered) * 100);
  return {
    generated,
    pending,
    stale,
    evidenceCoveragePercent,
  };
}

export function resolveMemoryRollupConfig(
  pluginConfig: Record<string, unknown>,
): MemoryRollupConfig {
  const memoryRollups = asRecord(pluginConfig?.memoryRollups);
  return {
    enabled: Boolean(memoryRollups?.enabled ?? false),
    outputDir:
      typeof memoryRollups?.outputDir === "string" && memoryRollups.outputDir.trim().length > 0
        ? memoryRollups.outputDir.trim()
        : DEFAULT_ROLLUP_DIR,
    maxMessages:
      Number.isFinite(Number(memoryRollups?.maxMessages)) && Number(memoryRollups?.maxMessages) > 0
        ? Math.max(1, Math.trunc(Number(memoryRollups.maxMessages)))
        : DEFAULT_MAX_MESSAGES,
    maxSummaryChars:
      Number.isFinite(Number(memoryRollups?.maxSummaryChars)) &&
      Number(memoryRollups?.maxSummaryChars) > 0
        ? Math.max(200, Math.trunc(Number(memoryRollups.maxSummaryChars)))
        : DEFAULT_MAX_SUMMARY_CHARS,
    redactSecrets:
      memoryRollups?.redactSecrets === undefined
        ? DEFAULT_REDACT_SECRETS
        : Boolean(memoryRollups.redactSecrets),
  };
}

type TranscriptLine = {
  role: "user" | "assistant";
  text: string;
  sourceLine: number;
  timestampMs: number;
};

type RollupSection = {
  title: string;
  bullets: string[];
};

type BuiltRollup = {
  path: string;
  markdown: string;
  agentId: string;
  sourceTranscript: string;
  sessionId: string;
  messageCount: number;
  inputHash: string;
  startAt: string;
  endAt: string;
};

function stableHash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf-8").digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveRollupOutputDir(workspaceDir: string, outputDir: string): string {
  const trimmed = outputDir.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.join(workspaceDir, trimmed);
}

function resolveSessionSourceTranscript(sourcePath: string, entryPath?: string): string {
  const normalizedEntryPath =
    typeof entryPath === "string" && entryPath.trim().length > 0
      ? entryPath
      : sessionPathForFile(sourcePath);
  return normalizedEntryPath.replaceAll("\\", "/");
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
}

function sessionStemForRollup(sourceTranscript: string, agentId: string): string {
  let stem = sourceTranscript.replaceAll("\\", "/").replace(/^sessions\//, "");
  const agentPrefix = `${agentId.replaceAll("\\", "/")}/`;
  if (stem.startsWith(agentPrefix)) {
    stem = stem.slice(agentPrefix.length);
  }
  return stem.replace(/\.jsonl$/i, "");
}

function resolveRollupOutputPath(params: {
  workspaceDir: string;
  outputDir: string;
  sourceTranscript: string;
  agentId: string;
}): string {
  const outputRoot = resolveRollupOutputDir(params.workspaceDir, params.outputDir);
  const safeAgent = sanitizePathSegment(params.agentId || "default");
  const stem = sanitizePathSegment(sessionStemForRollup(params.sourceTranscript, params.agentId));
  return path.join(outputRoot, safeAgent, `${stem || "session"}.md`);
}

function resolveRollupAgentOutputDir(params: {
  workspaceDir: string;
  outputDir: string;
  agentId: string;
}): string {
  const outputRoot = resolveRollupOutputDir(params.workspaceDir, params.outputDir);
  const safeAgent = sanitizePathSegment(params.agentId || "default");
  return path.join(outputRoot, safeAgent);
}

function parseRollupFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) {
    return {};
  }
  const parsed: Record<string, string> = {};
  const lines = match[1]?.split(/\r?\n/) ?? [];
  for (const line of lines) {
    const parsedLine = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!parsedLine) {
      continue;
    }
    const key = parsedLine[1];
    let value = (parsedLine[2] ?? "").trim();
    if (!key) {
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function redactSensitive(value: string, enabled: boolean): string {
  if (!enabled) {
    return value;
  }
  const withApiKeys = value.replace(
    /\b(?:api[_-]?key|auth[_-]?token|bearer\s+[A-Za-z0-9._-]{10,}|x-[A-Za-z0-9._-]+-token|sk_live_|sk_test_)[^\s\n]*/gi,
    "[redacted]",
  );
  return withApiKeys.replace(/\bpassword\s*[:=]\s*[^\s\n]+/gi, "password=[redacted]");
}

function truncateWithEllipsis(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = "…";
  const keep = Math.max(4, maxChars - suffix.length);
  return `${value.slice(0, keep).trim()}${suffix}`;
}

function parseTranscriptMessages(entry: SessionFileEntry): TranscriptLine[] {
  const bySourceLine = new Map<
    number,
    { role: "user" | "assistant"; text: string[]; timestampMs: number }
  >();
  const rawLines = entry.content.split(/\r?\n/);

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    const match = /^\s*(User|Assistant)\s*:\s*(.*)$/i.exec(rawLine);
    if (!match) {
      continue;
    }
    const role = match[1]?.toLowerCase() === "assistant" ? "assistant" : "user";
    const text = normalizeText(match[2] ?? "");
    if (!text) {
      continue;
    }
    const sourceLine = entry.lineMap[index] ?? index + 1;
    const timestampMs = entry.messageTimestampsMs[index] ?? 0;
    const existing = bySourceLine.get(sourceLine);
    if (!existing) {
      bySourceLine.set(sourceLine, {
        role,
        text: [text],
        timestampMs: timestampMs > 0 ? timestampMs : 0,
      });
      continue;
    }
    existing.text.push(text);
    if (timestampMs > 0) {
      existing.timestampMs = Math.max(existing.timestampMs, timestampMs);
    }
  }

  return [...bySourceLine.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bucket]) => ({
      role: bucket.role,
      text: normalizeText(bucket.text.join(" ")),
      sourceLine: 0,
      timestampMs: bucket.timestampMs,
    }))
    .filter((message) => message.text.length > 0);
}

function uniqueLines(lines: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(line);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function summarizeSession(
  messages: TranscriptLine[],
  maxMessages: number,
): {
  intent: string;
  decisions: string[];
  followUps: string[];
  pointers: string[];
  messageCount: number;
  startAt: string;
  endAt: string;
} {
  const bounded = messages.slice(-Math.max(1, maxMessages));
  const timestamped = bounded
    .map((message) => message.timestampMs)
    .filter((timestampMs) => timestampMs > 0);
  const fallbackMs = 0;
  const startAt = (
    timestamped.length > 0 ? new Date(Math.min(...timestamped)) : new Date(fallbackMs)
  ).toISOString();
  const endAt = (
    timestamped.length > 0 ? new Date(Math.max(...timestamped)) : new Date(fallbackMs)
  ).toISOString();

  const decisionPatterns = [
    /\b(?:decided|decide|set|enabled?|disabled?|configured|approve|approved|rollout|deployed|migrated|removed|added|renamed|changed|switched|resolved)\b/i,
    /\bI\b.*\bwill\b/i,
  ];
  const followUpPatterns = [
    /\b(?:TODO|todo|follow[- ]?up|next step|next|pending|later|schedule|remind|investigate|check|verify|review|test|need|should|could)\b/i,
    /\?/,
  ];

  const findMatches = (patterns: RegExp[]): string[] => {
    const hits: string[] = [];
    for (const message of bounded) {
      for (const pattern of patterns) {
        if (!pattern.test(message.text)) {
          continue;
        }
        hits.push(normalizeText(message.text));
        break;
      }
    }
    return uniqueLines(hits, 8);
  };

  const firstSpeaker = bounded.find((message) => message.text.length > 0);
  const intent = firstSpeaker
    ? truncateWithEllipsis(firstSpeaker.text, Math.max(80, Math.floor(maxMessages / 2)))
    : "No conversational content available.";

  return {
    intent,
    decisions: findMatches(decisionPatterns),
    followUps: findMatches(followUpPatterns),
    pointers: uniqueLines(
      bounded.map((message) => `${message.role}: ${message.text}`),
      6,
    ),
    messageCount: bounded.length,
    startAt,
    endAt,
  };
}

function formatSection(section: RollupSection): string {
  const lines = [`## ${section.title}`];
  if (section.bullets.length === 0) {
    lines.push("- No entries found.");
    return lines.join("\n");
  }
  for (const bullet of section.bullets) {
    lines.push(`- ${bullet}`);
  }
  return lines.join("\n");
}

function formatSectionValue(value: string): string {
  return value.includes("\n") ? `| ${value.replaceAll("\n", " ")}` : value;
}

function formatFrontmatterValue(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (/[:\[\]{}&,\n\r"']/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function formatSessionRollupMarkdown(
  summary: SessionRollupSummaryLine & {
    intent: string;
    decisions: string[];
    followUps: string[];
    pointers: string[];
    maxSummaryChars: number;
    redactSecrets: boolean;
    agentId: string;
  },
): string {
  const sections = [
    formatSection({
      title: "Session Intent",
      bullets: [summary.intent].map((entry) => redactSensitive(entry, summary.redactSecrets)),
    }),
    formatSection({
      title: "Key Decisions",
      bullets: summary.decisions.map((entry) => redactSensitive(entry, summary.redactSecrets)),
    }),
    formatSection({
      title: "Open Follow-ups",
      bullets: summary.followUps.map((entry) => redactSensitive(entry, summary.redactSecrets)),
    }),
    formatSection({
      title: "Verification Artifacts",
      bullets: [
        `sourceTranscript: ${formatSectionValue(redactSensitive(summary.sourceTranscript, summary.redactSecrets))}`,
        `sessionId: ${formatSectionValue(summary.sessionId)}`,
        `messageCount: ${String(summary.messageCount)}`,
        `inputHash: ${summary.inputHash}`,
        `rollupSchema: ${summary.rollupSchema}`,
        ...summary.pointers.map((entry) =>
          redactSensitive(formatSectionValue(entry), summary.redactSecrets),
        ),
      ],
    }),
  ];

  const body = sections.join("\n\n");
  const frontmatter = [
    "---",
    `sourceTranscript: ${formatFrontmatterValue(summary.sourceTranscript)}`,
    `sessionId: ${formatFrontmatterValue(summary.sessionId)}`,
    `agentId: ${formatFrontmatterValue(summary.agentId)}`,
    `startAt: ${formatFrontmatterValue(summary.startAt)}`,
    `endAt: ${formatFrontmatterValue(summary.endAt)}`,
    `messageCount: ${String(summary.messageCount)}`,
    `inputHash: ${formatFrontmatterValue(summary.inputHash)}`,
    `rollupSchema: ${formatFrontmatterValue(summary.rollupSchema)}`,
    "---",
    "",
  ].join("\n");
  if (frontmatter.length + body.length <= summary.maxSummaryChars) {
    return `${frontmatter}${body}\n`;
  }
  const budgetForBody = Math.max(120, summary.maxSummaryChars - frontmatter.length);
  return `${frontmatter}${truncateWithEllipsis(body, budgetForBody)}\n`;
}

function deriveSessionId(agentId: string, sourceTranscript: string): string {
  const safeAgent = sanitizePathSegment(agentId || "default");
  const safeSource = sanitizePathSegment(sessionStemForRollup(sourceTranscript, agentId));
  return `${safeAgent}__${safeSource}`;
}

function buildInputHash(
  entry: SessionFileEntry,
  sourceTranscript: string,
  messageCount: number,
  config: MemoryRollupConfig,
): string {
  return stableHash(
    `${entry.hash}|${sourceTranscript}|${messageCount}|${config.maxMessages}|${config.maxSummaryChars}|${config.redactSecrets ? 1 : 0}`,
  );
}

function buildSessionRollup(params: {
  workspaceDir: string;
  agentId: string;
  sourceTranscript: string;
  entry: SessionFileEntry;
  config: MemoryRollupConfig;
}): BuiltRollup {
  const messages = parseTranscriptMessages(params.entry);
  const summary = summarizeSession(messages, params.config.maxMessages);
  const inputHash = buildInputHash(
    params.entry,
    params.sourceTranscript,
    summary.messageCount,
    params.config,
  );
  const sessionId = deriveSessionId(params.agentId, params.sourceTranscript);
  const markdown = formatSessionRollupMarkdown({
    sourceTranscript: params.sourceTranscript,
    agentId: params.agentId,
    sessionId,
    startAt: summary.startAt,
    endAt: summary.endAt,
    messageCount: summary.messageCount,
    inputHash,
    rollupSchema: DEFAULT_ROLLUP_SCHEMA,
    intent: summary.intent,
    decisions: summary.decisions,
    followUps: summary.followUps,
    pointers: summary.pointers,
    maxSummaryChars: params.config.maxSummaryChars,
    redactSecrets: params.config.redactSecrets,
  });

  const outputPath = resolveRollupOutputPath({
    workspaceDir: params.workspaceDir,
    outputDir: params.config.outputDir,
    sourceTranscript: params.sourceTranscript,
    agentId: params.agentId,
  });

  return {
    path: outputPath,
    markdown,
    agentId: params.agentId,
    sourceTranscript: params.sourceTranscript,
    sessionId,
    messageCount: summary.messageCount,
    inputHash,
    startAt: summary.startAt,
    endAt: summary.endAt,
  };
}

async function listMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(child)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(child);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

export async function inspectSessionRollupPlan(params: {
  workspaceDir: string;
  agentId: string;
  config: MemoryRollupConfig;
  forceSessionFiles?: string[];
}): Promise<SessionRollupPlan> {
  if (!params.config.enabled) {
    return {
      config: params.config,
      discovered: 0,
      generated: 0,
      pending: 0,
      stale: 0,
      orphaned: 0,
      actions: [],
      orphans: [],
      evidenceCoveragePercent: 100,
    };
  }

  const sessionFiles =
    params.forceSessionFiles && params.forceSessionFiles.length > 0
      ? params.forceSessionFiles.map((entry) => path.resolve(entry))
      : (await listSessionFilesForAgent(params.agentId)).map((entry) => path.resolve(entry));

  const outputDir = resolveRollupAgentOutputDir({
    workspaceDir: params.workspaceDir,
    outputDir: params.config.outputDir,
    agentId: params.agentId,
  });
  const discoveredRollups = await listMarkdownFiles(outputDir);

  const parsedRollupBySource = new Map<string, { path: string; inputHash?: string }>();
  const orphanCandidates: SessionRollupOrphan[] = [];

  for (const filePath of discoveredRollups) {
    const raw = await fs.readFile(filePath, "utf-8").catch(() => null);
    if (!raw) {
      orphanCandidates.push({ outputPath: filePath, reason: "unparseable" });
      continue;
    }
    const frontmatter = parseRollupFrontmatter(raw);
    const sourceTranscript =
      typeof frontmatter.sourceTranscript === "string" ? frontmatter.sourceTranscript : "";
    const trimmedSourceTranscript = sourceTranscript.trim();
    if (!trimmedSourceTranscript) {
      orphanCandidates.push({ outputPath: filePath, reason: "unparseable" });
      continue;
    }
    if (!parsedRollupBySource.has(trimmedSourceTranscript)) {
      parsedRollupBySource.set(trimmedSourceTranscript, {
        path: filePath,
        inputHash: typeof frontmatter.inputHash === "string" ? frontmatter.inputHash : undefined,
      });
    }
  }

  const discoveredSessions = new Set<string>();
  const actions: SessionRollupAction[] = [];
  for (const sourcePath of sessionFiles.toSorted()) {
    const entry = await buildSessionEntry(sourcePath);
    if (!entry) {
      continue;
    }

    const sourceTranscript = resolveSessionSourceTranscript(sourcePath, entry.path);
    discoveredSessions.add(sourceTranscript);
    const built = buildSessionRollup({
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      sourceTranscript,
      entry,
      config: params.config,
    });
    const existing = parsedRollupBySource.get(sourceTranscript);
    const status =
      existing?.inputHash === built.inputHash && existing.path === built.path
        ? "upToDate"
        : existing
          ? "stale"
          : "missing";

    actions.push({
      sourcePath,
      outputPath: built.path,
      sourceTranscript,
      status,
      inputHash: built.inputHash,
      outputHash: existing?.inputHash,
      outputCreated: false,
      outputUpdated: false,
      generated: false,
    });
  }

  const expectedPathBySource = new Map<string, string>(
    actions.map((action) => [action.sourceTranscript, action.outputPath]),
  );

  const orphans: SessionRollupOrphan[] = [...orphanCandidates];
  for (const [sourceTranscript, existing] of parsedRollupBySource) {
    const expectedPath = expectedPathBySource.get(sourceTranscript);
    if (!discoveredSessions.has(sourceTranscript)) {
      orphans.push({
        outputPath: existing.path,
        reason: "orphan",
        sourceTranscript,
      });
      continue;
    }
    if (expectedPath !== existing.path) {
      orphans.push({
        outputPath: existing.path,
        reason: "orphan",
        sourceTranscript,
      });
    }
  }

  const dedupeOrphans = new Map<string, SessionRollupOrphan>();
  for (const orphan of orphans) {
    dedupeOrphans.set(orphan.outputPath, orphan);
  }

  const actionSummary = summarizeRollupActions(actions);
  const discovered = actions.length;

  return {
    config: params.config,
    discovered,
    generated: actionSummary.generated,
    pending: actionSummary.pending,
    stale: actionSummary.stale,
    orphaned: dedupeOrphans.size,
    actions,
    orphans: [...dedupeOrphans.values()],
    evidenceCoveragePercent: actionSummary.evidenceCoveragePercent,
  };
}

export async function writeSessionRollups(params: {
  workspaceDir: string;
  agentId: string;
  config: MemoryRollupConfig;
  dryRun?: boolean;
  apply?: boolean;
  forceSessionFiles?: string[];
}): Promise<SessionRollupGenerationResult> {
  const plan = await inspectSessionRollupPlan({
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    config: params.config,
    forceSessionFiles: params.forceSessionFiles,
  });

  if (!plan.config.enabled) {
    return {
      ...plan,
      wrote: 0,
      unchanged: 0,
      skipped: plan.discovered,
    };
  }

  const shouldApply = Boolean(params.apply) && !Boolean(params.dryRun);
  let wrote = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const action of plan.actions) {
    if (action.status === "upToDate") {
      unchanged += 1;
      continue;
    }

    if (!shouldApply) {
      skipped += 1;
      continue;
    }

    const entry = await buildSessionEntry(action.sourcePath);
    if (!entry) {
      skipped += 1;
      action.reason = "transcript-unreadable";
      continue;
    }

    const built = buildSessionRollup({
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      sourceTranscript: action.sourceTranscript,
      entry,
      config: params.config,
    });

    await fs.mkdir(path.dirname(built.path), { recursive: true });
    await fs.writeFile(built.path, built.markdown, "utf-8");

    const previousStatus = action.status;

    wrote += 1;
    action.status = "upToDate";
    action.generated = true;
    action.outputCreated = previousStatus === "missing";
    action.outputUpdated = previousStatus === "stale";
    action.outputPath = built.path;
    action.outputHash = built.inputHash;
  }

  const finalSummary = summarizeRollupActions(plan.actions);

  return {
    ...plan,
    generated: finalSummary.generated,
    pending: finalSummary.pending,
    stale: finalSummary.stale,
    evidenceCoveragePercent: finalSummary.evidenceCoveragePercent,
    wrote,
    unchanged,
    skipped,
  };
}

export const sessionRollupsDefaults = {
  outputDir: DEFAULT_ROLLUP_DIR,
  maxMessages: DEFAULT_MAX_MESSAGES,
  maxSummaryChars: DEFAULT_MAX_SUMMARY_CHARS,
  redactSecrets: DEFAULT_REDACT_SECRETS,
  enabled: false,
  sourceStaleWarningRatio: SOURCE_STALE_WARNING_RATIO,
};
