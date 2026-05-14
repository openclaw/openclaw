// Block serializer/parser for the file-based log-memory store.
//
// Episodic block (one per ingested log chunk, lives in YYYY-MM-DD.md):
//
//   ## [2026-05-07T12:00:00.000Z] level:ERROR service:diagfw host:dut-01
//   probe disconnected after relay reset
//   decay: 0.95
//   accessCount: 0
//
// Semantic block (lives in KNOWLEDGE.md, written by dream cycle and engineer
// teaching capture):
//
//   ## [2026-05-07T12:00:00.000Z] Probe stuck pattern
//   Pattern: Repeated probe disconnects on diagfw.
//   Root cause: Jig misalignment.
//   Tags: service:diagfw, level:ERROR
//   Source: dream_consolidation
//
// The shared parsing strategy: a block runs from one `## [` heading to the
// next; trailing `Key: value` lines are metadata; everything else between the
// heading and the trailing metadata block is the body.

import { computeEntryId } from "./dedupe.js";
import type { LogMemoryEntry, LogMemoryLayer, LogMemoryPayload } from "./types.js";

const HEADING_RE = /^## \[(?<ts>[^\]]+)\](?<rest>.*)$/;
const META_LINE_RE = /^(?<key>[A-Za-z][A-Za-z _]*?):\s*(?<value>.*)$/;
// `consolidatedAt` is optional — only present once the dream cycle has
// consolidated the entry into the semantic layer.
const EPISODIC_META_KEYS = new Set(["decay", "accessCount", "consolidatedAt"]);
// `Type` and `Pinned` are optional — added when non-default so existing files
// without them continue to parse correctly.
const SEMANTIC_META_KEYS = new Set(["Pattern", "Root cause", "Tags", "Source", "Type", "Pinned"]);

export function serializeEpisodicBlock(entry: LogMemoryEntry): string {
  const heading = `## [${entry.timestamp.toISOString()}] ${entry.payload.tags.join(" ")}`.trimEnd();
  const body = sanitizeBody(entry.payload.content);
  const lines = [
    heading,
    body,
    `decay: ${formatNumber(entry.payload.decayScore)}`,
    `accessCount: ${entry.payload.accessCount}`,
  ];
  if (entry.payload.consolidatedAt) {
    lines.push(`consolidatedAt: ${entry.payload.consolidatedAt.toISOString()}`);
  }
  return `${lines.join("\n")}\n`;
}

export function serializeSemanticBlock(entry: LogMemoryEntry): string {
  const title = entry.payload.title?.trim() || deriveTitle(entry.payload.content);
  const heading = `## [${entry.timestamp.toISOString()}] ${title}`.trimEnd();
  const pattern = sanitizeInline(entry.payload.content);
  const rootCause = sanitizeInline(entry.payload.rootCause ?? "");
  const tags = entry.payload.tags.join(", ");
  const lines = [
    heading,
    `Pattern: ${pattern}`,
    `Root cause: ${rootCause}`,
    `Tags: ${tags}`,
    `Source: ${entry.payload.source}`,
  ];
  // Write Type only when it is not the legacy default so old readers are
  // unaffected by the new field.
  if (entry.payload.type !== "error_pattern" && entry.payload.type !== "engineer_knowledge") {
    lines.push(`Type: ${entry.payload.type}`);
  }
  if (entry.payload.pinned) {
    lines.push("Pinned: true");
  }
  return `${lines.join("\n")}\n`;
}

export interface ParseBlocksOptions {
  layer: LogMemoryLayer;
  // Defaults applied when a field is absent. Useful for the episodic layer
  // where new fields might be introduced over time.
  defaultPayloadType?: LogMemoryPayload["type"];
  defaultSource?: LogMemoryPayload["source"];
}

export function parseBlocks(content: string, opts: ParseBlocksOptions): LogMemoryEntry[] {
  const lines = content.split(/\r?\n/);
  const blocks: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      if (current) {
        blocks.push(current);
      }
      current = { heading: line, body: [] };
      continue;
    }
    if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    blocks.push(current);
  }
  const out: LogMemoryEntry[] = [];
  for (const block of blocks) {
    const entry = parseSingleBlock(block.heading, block.body, opts);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

function parseSingleBlock(
  heading: string,
  body: string[],
  opts: ParseBlocksOptions,
): LogMemoryEntry | null {
  const m = HEADING_RE.exec(heading);
  if (!m?.groups) {
    return null;
  }
  const timestamp = new Date(m.groups.ts);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }
  const headingRest = m.groups.rest.trim();

  // Walk body lines and collect trailing metadata (in reverse) until we hit a
  // line that doesn't look like a metadata key the layer cares about. Strip
  // trailing blank lines first so they don't confuse the walk.
  const trimmed = trimTrailingBlanks(body);
  const knownKeys = opts.layer === "semantic" ? SEMANTIC_META_KEYS : EPISODIC_META_KEYS;
  const metadata = new Map<string, string>();
  let cutoff = trimmed.length;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const line = trimmed[i];
    const meta = META_LINE_RE.exec(line);
    if (!meta?.groups) {
      break;
    }
    const key = meta.groups.key.trim();
    if (!knownKeys.has(key)) {
      break;
    }
    metadata.set(key, meta.groups.value);
    cutoff = i;
  }
  const bodyLines = trimTrailingBlanks(trimmed.slice(0, cutoff));
  const bodyText = bodyLines.join("\n");

  if (opts.layer === "episodic") {
    return buildEpisodicEntry({ timestamp, headingRest, bodyText, metadata, opts });
  }
  return buildSemanticEntry({ timestamp, headingRest, bodyText, metadata, opts });
}

function buildEpisodicEntry(input: {
  timestamp: Date;
  headingRest: string;
  bodyText: string;
  metadata: Map<string, string>;
  opts: ParseBlocksOptions;
}): LogMemoryEntry {
  const tags = input.headingRest
    .split(/\s+/u)
    .map((tok) => tok.trim())
    .filter((tok) => tok.length > 0);
  const decay = parseNumber(input.metadata.get("decay"), 0);
  const accessCount = Math.max(0, Math.floor(parseNumber(input.metadata.get("accessCount"), 0)));
  const consolidatedAtRaw = input.metadata.get("consolidatedAt");
  const consolidatedAt = consolidatedAtRaw ? parseConsolidatedAt(consolidatedAtRaw) : undefined;
  const service = extractServiceFromTags(tags);
  const id = computeEntryId({
    timestamp: input.timestamp,
    service,
    message: input.bodyText,
  });
  return {
    id,
    timestamp: input.timestamp,
    layer: "episodic",
    payload: {
      type: input.opts.defaultPayloadType ?? "raw_log",
      content: input.bodyText,
      tags,
      source: input.opts.defaultSource ?? "log_ingest",
      decayScore: decay,
      accessCount,
      lastAccessedAt: input.timestamp,
      consolidatedAt,
    },
  };
}

function parseConsolidatedAt(raw: string): Date | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function buildSemanticEntry(input: {
  timestamp: Date;
  headingRest: string;
  bodyText: string;
  metadata: Map<string, string>;
  opts: ParseBlocksOptions;
}): LogMemoryEntry {
  const title = input.headingRest;
  const pattern = (input.metadata.get("Pattern") ?? input.bodyText).trim();
  const rootCause = (input.metadata.get("Root cause") ?? "").trim();
  const tagsRaw = input.metadata.get("Tags") ?? "";
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const sourceRaw = (
    input.metadata.get("Source") ??
    input.opts.defaultSource ??
    "dream_consolidation"
  ).trim();
  const source = normalizeSource(sourceRaw);
  const typeRaw = (input.metadata.get("Type") ?? "").trim();
  const type = typeRaw
    ? normalizePayloadType(typeRaw, source)
    : source === "engineer_teach"
      ? "engineer_knowledge"
      : "error_pattern";
  const pinned = input.metadata.get("Pinned")?.trim().toLowerCase() === "true";
  const id = computeEntryId({
    timestamp: input.timestamp,
    service: "semantic",
    message: `${title}\n${pattern}`,
  });
  // Semantic decay is recomputed from importance + age via decay.ts; we still
  // record an initial value to feed selectDreamCandidates, etc.
  const decayScore = type === "engineer_knowledge" || type === "conversation_rule" ? 0.95 : 0.9;
  return {
    id,
    timestamp: input.timestamp,
    layer: "semantic",
    payload: {
      type,
      content: pattern,
      tags,
      source,
      decayScore,
      pinned: pinned || undefined,
      accessCount: 0,
      lastAccessedAt: input.timestamp,
      title,
      rootCause,
    },
  };
}

function normalizeSource(raw: string): LogMemoryPayload["source"] {
  if (raw === "engineer_teach" || raw === "log_ingest" || raw === "dream_consolidation") {
    return raw;
  }
  return "dream_consolidation";
}

function normalizePayloadType(
  raw: string,
  source: LogMemoryPayload["source"],
): LogMemoryPayload["type"] {
  if (
    raw === "raw_log" ||
    raw === "error_pattern" ||
    raw === "incident_summary" ||
    raw === "engineer_knowledge" ||
    raw === "conversation_rule"
  ) {
    return raw;
  }
  return source === "engineer_teach" ? "engineer_knowledge" : "error_pattern";
}

function extractServiceFromTags(tags: string[]): string {
  const svc = tags.find((tag) => tag.startsWith("service:"));
  return svc ? svc.slice("service:".length) : "";
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value: number): string {
  // Up to 4 decimal places, no trailing zeros — keeps the file diff-friendly.
  return Number(value.toFixed(4)).toString();
}

function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim().length === 0) {
    end--;
  }
  return lines.slice(0, end);
}

// Avoid log content that begins a line with "## " from being interpreted as a
// new block heading on read. We also collapse CR/LF so later splits are clean.
function sanitizeBody(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (/^##\s/.test(line) ? `​${line}` : line))
    .join("\n")
    .trim();
}

function sanitizeInline(content: string): string {
  return content.replace(/\r?\n/g, " ").trim();
}

function deriveTitle(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return "untitled";
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
