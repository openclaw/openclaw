import fs from "node:fs/promises";
import path from "node:path";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { isUsageCountedSessionTranscriptFileName } from "../../../../src/config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../../../../src/config/sessions/paths.js";
import { redactSensitiveText } from "../../../../src/logging/redact.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");
const RELEVANT_MEMORIES_BLOCK_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi;

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

type SessionRecordLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
  runId?: unknown;
  role?: unknown;
  content?: unknown;
  text?: unknown;
};

function isRecordObject(value: unknown): value is SessionRecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDreamingNarrativeBootstrapRecord(record: unknown): boolean {
  if (!isRecordObject(record)) {
    return false;
  }
  const candidate = record;
  if (
    candidate.type !== "custom" ||
    candidate.customType !== "openclaw:bootstrap-context:full" ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data)
  ) {
    return false;
  }
  const runId = isRecordObject(candidate.data) ? candidate.data.runId : undefined;
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

function stripRelevantMemoriesEnvelope(text: string): string {
  return text.replace(RELEVANT_MEMORIES_BLOCK_RE, " ");
}

function isSilentReplyScaffolding(text: string): boolean {
  return /^(?:NO_REPLY|SKIPPED)$/i.test(text.trim());
}

function isCronTaskEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (!/^\[cron:[^\]]+]/i.test(trimmed)) {
    return false;
  }
  return /(?:\btask_role=|\btask_origin=|\bnotify_policy=|Current time:|reply\s+`?NO_REPLY`?|Return your response as plain text|A scheduled reminder has been triggered\.)/i.test(
    trimmed,
  );
}

function isAsyncExecReceiptEnvelope(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^System \(untrusted\):\s*\[[^\]]+\]\s*(?:Exec|Process)\s+(?:completed|failed)/i.test(
      trimmed,
    ) || /An async command you ran earlier has completed\./i.test(trimmed)
  );
}

function isStartupResetEnvelope(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^\[Startup context loaded by runtime\]/i.test(trimmed) ||
    /Bootstrap files like SOUL\.md, USER\.md, and MEMORY\.md/i.test(trimmed) ||
    /A new session was started via \/new or \/reset\./i.test(trimmed) ||
    /Execute your Session Startup sequence now/i.test(trimmed)
  );
}

function stripSessionScaffolding(text: string, role: "user" | "assistant"): string {
  let next = text;
  if (role === "user") {
    next = stripInboundMetadata(next);
    next = stripRelevantMemoriesEnvelope(next);
  }
  next = normalizeSessionText(next);
  if (!next) {
    return "";
  }
  if (isSilentReplyScaffolding(next)) {
    return "";
  }
  if (role === "user") {
    if (
      isCronTaskEnvelope(next) ||
      isAsyncExecReceiptEnvelope(next) ||
      isStartupResetEnvelope(next)
    ) {
      return "";
    }
  }
  return next;
}

function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecordObject(block)) {
      continue;
    }
    const record = block;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export function extractSessionText(
  content: unknown,
  role: "user" | "assistant" = "assistant",
): string | null {
  const rawText = collectRawSessionText(content);
  if (rawText === null) {
    return null;
  }
  const stripped = stripSessionScaffolding(rawText, role);
  const normalized = normalizeSessionText(stripped);
  return normalized ? normalized : null;
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
      if (!isRecordObject(record) || record.type !== "message") {
        continue;
      }
      const message = isRecordObject(record.message) ? record.message : undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content, message.role);
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
