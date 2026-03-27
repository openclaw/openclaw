import fs from "node:fs/promises";
import path from "node:path";
import { stripLeadingInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { isUsageCountedSessionTranscriptFileName } from "../../../../src/config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../../../../src/config/sessions/paths.js";
import { redactSensitiveText } from "../../../../src/logging/redact.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { hashText } from "./internal.js";

/**
 * Matches one or more leading directive tags (audio/reply) at the very start of text,
 * optionally preceded by whitespace.  Inline mentions pass through unchanged so they
 * remain searchable in the memory index.
 */
const LEADING_DIRECTIVE_TAGS_RE =
  /^(\s*\[\[\s*(?:audio_as_voice|reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*)+/i;

const log = createSubsystemLogger("memory");

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
};

function isDreamingNarrativeBootstrapRecord(record: unknown): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const candidate = record as {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  };
  if (
    candidate.type !== "custom" ||
    candidate.customType !== "openclaw:bootstrap-context:full" ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data)
  ) {
    return false;
  }
  const runId = (candidate.data as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.startsWith("dreaming-narrative-");
}

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => isUsageCountedSessionTranscriptFileName(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips OpenClaw-injected metadata from a raw content string before
 * normalization. Must be called on the original multi-line text so that
 * the line-based sentinel detection in `stripLeadingInboundMetadata` works correctly.
 */
function stripRawContentMeta(raw: string, role: "user" | "assistant"): string {
  // Only strip inbound metadata for user messages — assistant responses may
  // legitimately quote or discuss metadata headers (e.g. troubleshooting output).
  // Fast-path: skip stripping entirely when the text clearly contains no injected
  // metadata. We check for '<' (XML-style tag blocks) and both cases of "untrusted"
  // to cover all sentinel variants (review comments #2998605546, #3000971886):
  //   INBOUND_META_SENTINELS  → all contain "untrusted" (lowercase)
  //   UNTRUSTED_CONTEXT_HEADER → starts with "Untrusted" (capital U)
  const mightHaveMeta =
    role === "user" &&
    (raw.includes("<") || raw.includes("untrusted") || raw.includes("Untrusted"));
  const afterMeta = mightHaveMeta ? stripLeadingInboundMetadata(raw) : raw;
  if (!afterMeta.includes("[[")) {
    return afterMeta;
  }
  // Only strip directive tags at leading control-tag positions (start of text),
  // and only for user messages. Assistant responses may legitimately begin with
  // [[reply_to_current]] or [[reply_to:...]] (e.g. structured reply formatting,
  // tool output quoting, or discussion of the directive protocol) — silently
  // rewriting them would corrupt the searchable transcript index.
  if (role !== "user") {
    return afterTs;
  }
  // Inline mid-text mentions (e.g. discussing [[reply_to_current]] in docs)
  // are left intact so they remain searchable in the memory index.
  return afterMeta.replace(LEADING_DIRECTIVE_TAGS_RE, "");
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

/**
 * Like `extractSessionText` but strips OpenClaw-injected inbound metadata
 * blocks and inline directive tags from raw content *before* normalization.
 * Stripping must happen pre-normalization so that line-based sentinel
 * detection in `stripLeadingInboundMetadata` can identify the fenced JSON blocks.
 *
 * The `role` parameter controls whether `stripLeadingInboundMetadata` is applied:
 * only `user` messages have their metadata blocks removed. Assistant messages
 * may legitimately reference metadata headers, so they are kept intact.
 */
function extractAndStripSessionText(content: unknown, role: "user" | "assistant"): string | null {
  if (typeof content === "string") {
    const clean = stripRawContentMeta(content, role);
    const normalized = normalizeSessionText(clean);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const clean = stripRawContentMeta(record.text, role);
    const normalized = normalizeSessionText(clean);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    const lineMap: number[] = [];
    let generatedByDreamingNarrative = false;
    for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
      const line = lines[jsonlIdx];
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!generatedByDreamingNarrative && isDreamingNarrativeBootstrapRecord(record)) {
        generatedByDreamingNarrative = true;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractAndStripSessionText(message.content, message.role);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${safe}`);
      lineMap.push(jsonlIdx + 1);
    }
    const content = collected.join("\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content + "\n" + lineMap.join(",")),
      content,
      lineMap,
      ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
