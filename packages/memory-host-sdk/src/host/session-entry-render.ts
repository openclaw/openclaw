import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { EXEC_TIMEOUT_RETRY_GUIDANCE } from "../../../../src/agents/bash-tools.exec-output.js";
import { stripInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
import { isHeartbeatUserMessage } from "../../../../src/auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../../../src/auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { HEARTBEAT_TOKEN } from "../../../../src/auto-reply/tokens.js";
import {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "../../../../src/config/sessions/artifacts.js";
import { hasInterSessionUserProvenance } from "../../../../src/sessions/input-provenance.js";
import {
  DREAMING_NARRATIVE_RUN_PREFIX,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
} from "../../../../src/sessions/session-key-utils.js";
import { prepareAssistantTranscriptText } from "../../../../src/shared/chat-message-content.js";
import {
  collectRawSessionText,
  hashSessionEntrySnapshot,
  parseSessionTimestampMs,
  renderSessionExportLines,
} from "./session-entry-projection.js";
import type {
  BuildSessionEntryOptions,
  SessionEntrySnapshot,
  SessionFileEntry,
  SessionFileState,
} from "./session-files.js";
import { classifySessionMessageOrigin } from "./session-provenance.js";
import {
  resolveSessionResetRecallCutoff,
  type SessionResetRecallCutoff,
} from "./session-reset-recall.js";
import type { MemoryEntryProvenance, MemoryOriginClass } from "./types.js";

const SESSION_ENTRY_PARSE_YIELD_LINES = 250;
const DIRECT_CRON_PROMPT_RE = /^\[cron:[^\]]+\]\s*/;
const SESSION_RESET_RECALL_CUTOFF = Symbol.for("openclaw.memory.sessionResetRecallCutoff");

type SessionEntrySource = SessionFileState &
  (
    | {
        kind: "sqlite";
        records: readonly unknown[];
        resetRecallCutoff: SessionResetRecallCutoff;
        sessionKey?: string;
      }
    | {
        kind: "file";
        raw: string;
        classification: {
          generatedByDreamingNarrative: boolean;
          generatedByCronRun: boolean;
        } | null;
      }
  );

export function readSessionEntryResetRecallCutoff(
  entry: SessionFileEntry,
): SessionResetRecallCutoff {
  const value: unknown = Object.getOwnPropertyDescriptor(entry, SESSION_RESET_RECALL_CUTOFF)?.value;
  if (!value || typeof value !== "object" || !("state" in value)) {
    return { state: "invalid" };
  }
  if (value.state === "absent" || value.state === "invalid") {
    return { state: value.state };
  }
  if (value.state === "valid" && "cutoffLine" in value && typeof value.cutoffLine === "number") {
    return { state: "valid", cutoffLine: value.cutoffLine };
  }
  return { state: "invalid" };
}

export function attachSessionEntryResetRecallCutoff(
  entry: SessionFileEntry,
  cutoff: SessionResetRecallCutoff,
): SessionFileEntry {
  Object.defineProperty(entry, SESSION_RESET_RECALL_CUTOFF, {
    configurable: false,
    enumerable: false,
    value: cutoff,
    writable: false,
  });
  return entry;
}

export function isUsageCountedSessionArchiveTranscriptPath(absPath: string): boolean {
  const fileName = path.basename(absPath);
  return (
    isUsageCountedSessionTranscriptFileName(fileName) &&
    isSessionArchiveArtifactName(fileName) &&
    parseUsageCountedSessionIdFromFileName(fileName) !== null
  );
}

function hasDreamingNarrativeIdentity(value: unknown): boolean {
  return typeof value === "string" && isDreamingNarrativeSessionStoreKey(value);
}

function isDreamingNarrativeGeneratedRecord(record: unknown): boolean {
  const candidate = asOptionalRecord(record);
  if (!candidate) {
    return false;
  }
  const data = asOptionalRecord(candidate.data);
  if (
    candidate.type === "custom" &&
    candidate.customType === "openclaw:bootstrap-context:full" &&
    typeof data?.runId === "string" &&
    data.runId.startsWith(DREAMING_NARRATIVE_RUN_PREFIX)
  ) {
    return true;
  }
  const message = candidate.type === "message" ? asOptionalRecord(candidate.message) : undefined;
  const metadata = asOptionalRecord(message?.["__openclaw"]);
  return (
    hasDreamingNarrativeIdentity(candidate.runId) ||
    hasDreamingNarrativeIdentity(candidate.sessionKey) ||
    hasDreamingNarrativeIdentity(data?.runId) ||
    hasDreamingNarrativeIdentity(data?.sessionKey) ||
    ((message?.role === "assistant" || message?.role === "toolResult") &&
      hasDreamingNarrativeIdentity(metadata?.runId))
  );
}

function hasCronRunSessionKey(value: unknown): boolean {
  return typeof value === "string" && isCronRunSessionKey(value);
}

function isCronRunGeneratedRecord(record: unknown): boolean {
  const candidate = asOptionalRecord(record);
  return (
    hasCronRunSessionKey(candidate?.sessionKey) ||
    hasCronRunSessionKey(asOptionalRecord(candidate?.data)?.sessionKey)
  );
}

/** Returns the logical memory path for a live SQLite-backed session transcript. */
export function sessionPathForSessionIdentity(agentId: string, sessionId: string): string {
  return path.join("sessions", normalizeAgentId(agentId), `${sessionId}.jsonl`).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const GENERATED_SYSTEM_MESSAGE_RE = /^System(?: \(untrusted\))?: \[[^\]]+\]\s*/;

function sanitizeSessionText(text: string, role: "user" | "assistant"): string | null {
  // Metadata envelopes require their original newlines; strip them before whitespace normalization.
  const strippedInbound = role === "user" ? stripInboundMetadata(text) : text;
  const strippedInternal = stripInternalRuntimeContext(strippedInbound);
  const normalized = normalizeSessionText(strippedInternal);
  if (!normalized) {
    return null;
  }
  if (
    role === "user" &&
    (GENERATED_SYSTEM_MESSAGE_RE.test(normalized) ||
      DIRECT_CRON_PROMPT_RE.test(normalized) ||
      isHeartbeatUserMessage({ role, content: normalized }, HEARTBEAT_PROMPT))
  ) {
    return null;
  }
  // Assistant-side machinery acks: HEARTBEAT_OK is the canonical "all clear,
  // nothing to do" reply to a heartbeat tick. Drop on the assistant side
  // directly so we do not have to rely on cross-message coupling with the
  // preceding user message (which a real user could spoof).
  if (role === "assistant" && normalized === HEARTBEAT_TOKEN) {
    return null;
  }
  const withoutSystemEnvelope = normalized.replace(GENERATED_SYSTEM_MESSAGE_RE, "").trim();
  if (isExecCompletionEvent(withoutSystemEnvelope)) {
    return null;
  }
  return normalized;
}

function resolveSessionEntryParseYieldLines(opts: BuildSessionEntryOptions): number {
  const configured = opts.parseYieldEveryLines;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(1, Math.floor(configured));
  }
  return SESSION_ENTRY_PARSE_YIELD_LINES;
}

export function sqliteSessionFileState(
  absPath: string,
  identity: { agentId: string; sessionId: string },
  stats: SessionEntrySnapshot["stats"],
  updatedAtMs?: number,
): SessionFileState {
  return {
    absPath,
    path: sessionPathForSessionIdentity(identity.agentId, identity.sessionId),
    mtimeMs: updatedAtMs ?? stats.maxSeq,
    revisionMs: stats.lastMutationAtMs ?? stats.maxSeq,
    size: stats.sizeBytes,
  };
}

async function yieldSessionEntryParseIfNeeded(
  lineIndex: number,
  everyLines: number,
): Promise<void> {
  if (lineIndex > 0 && lineIndex % everyLines === 0) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Recognize historical exec notices when exporting conversation text for memory. */
function isExecCompletionEvent(event: string): boolean {
  const trimmed = event.trim();
  if (/^exec finished(?::|\s*\()/i.test(trimmed)) {
    return true;
  }
  const match =
    /^exec (completed|failed) \(([a-z0-9_-]{1,64}), (code -?\d+|signal [^)]+)\)(?: :: ([\s\S]*)|\n\n([\s\S]+))?$/i.exec(
      trimmed,
    );
  return Boolean(match && (match[5] === undefined || match[5] === EXEC_TIMEOUT_RETRY_GUIDANCE));
}

/** Render the worker's admitted snapshot without entering host discovery or restoration. */
export function renderSessionEntrySnapshot(
  absPath: string,
  opts: BuildSessionEntryOptions & { agentId: string; sessionId: string; storePath: string },
  snapshot: SessionEntrySnapshot,
): Promise<SessionFileEntry> {
  return renderSessionEntry(absPath, opts, {
    ...sqliteSessionFileState(absPath, opts, snapshot.stats, opts.updatedAtMs),
    kind: "sqlite",
    records: snapshot.events,
    resetRecallCutoff: resolveSessionResetRecallCutoff(snapshot.events),
    sessionKey: snapshot.sessionKey,
  });
}

export async function renderSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions,
  source: SessionEntrySource,
): Promise<SessionFileEntry> {
  const { mtimeMs, size, path: memoryPath } = source;
  const sqliteSource = source.kind === "sqlite" ? source : null;
  const raw = source.kind === "file" ? source.raw : "";
  const sessionStoreClassification = source.kind === "file" ? source.classification : null;
  const collected: string[] = [];
  const lineMap: number[] = [];
  const messageTimestampsMs: number[] = [];
  const lineProvenance: MemoryEntryProvenance[] = [];
  const parseYieldEveryLines = resolveSessionEntryParseYieldLines(opts);
  const sqliteSessionKey = !opts.sessionKey ? sqliteSource?.sessionKey : undefined;
  let generatedByDreamingNarrative =
    opts.generatedByDreamingNarrative ??
    (sqliteSessionKey ? isDreamingNarrativeSessionStoreKey(sqliteSessionKey) : undefined) ??
    sessionStoreClassification?.generatedByDreamingNarrative ??
    false;
  let generatedByCronRun =
    opts.generatedByCronRun ??
    (sqliteSessionKey ? isCronRunSessionKey(sqliteSessionKey) : undefined) ??
    sessionStoreClassification?.generatedByCronRun ??
    false;
  const sessionKind = opts.sessionKind ?? "unknown";
  const allowArchiveRecordCronClassification = isUsageCountedSessionArchiveTranscriptPath(absPath);
  // A heartbeat owns every generated response until the next user turn. The
  // persisted runtime provenance makes this coupling safe from text spoofing.
  let insideHeartbeatTurn = false;
  let insideRecalledMemoryTurn = false;
  let turnOrigin: MemoryOriginClass = "untrusted";
  // SQLite is fully snapshotted before yielding or invoking observers. Archives
  // retain raw line ordinals, including blank and malformed JSONL entries.
  for (
    let jsonlIdx = 0, lineStart = 0;
    sqliteSource ? jsonlIdx < sqliteSource.records.length : lineStart <= raw.length;
    jsonlIdx++
  ) {
    await yieldSessionEntryParseIfNeeded(jsonlIdx, parseYieldEveryLines);
    let record: unknown;
    if (sqliteSource) {
      record = sqliteSource.records[jsonlIdx];
    } else {
      const newlineIndex = raw.indexOf("\n", lineStart);
      const lineEnd = newlineIndex === -1 ? raw.length : newlineIndex;
      const line = raw.slice(lineStart, lineEnd);
      lineStart = newlineIndex === -1 ? raw.length + 1 : newlineIndex + 1;
      if (!line.trim()) {
        continue;
      }
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
    }
    const identifiesDreamingNarrative =
      !generatedByDreamingNarrative && isDreamingNarrativeGeneratedRecord(record);
    const identifiesCronRun =
      !generatedByCronRun &&
      allowArchiveRecordCronClassification &&
      isCronRunGeneratedRecord(record);
    if (identifiesDreamingNarrative || identifiesCronRun) {
      generatedByDreamingNarrative ||= identifiesDreamingNarrative;
      generatedByCronRun ||= identifiesCronRun;
      collected.length = 0;
      lineMap.length = 0;
      messageTimestampsMs.length = 0;
      lineProvenance.length = 0;
    }
    const candidate = asOptionalRecord(record);
    if (candidate?.type !== "message") {
      continue;
    }
    const message = asOptionalRecord(candidate.message);
    if (!message || typeof message.role !== "string") {
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const timestampMs = parseSessionTimestampMs(candidate, message);
    opts.onTranscriptMessage?.(message, Math.max(0, Math.floor(timestampMs || mtimeMs)));
    const inputProvenance = asOptionalRecord(message.provenance);
    const isHeartbeatUser =
      message.role === "user" &&
      inputProvenance?.kind === "internal_system" &&
      inputProvenance.sourceTool === "heartbeat";
    if (message.role === "user") {
      insideHeartbeatTurn = isHeartbeatUser;
      insideRecalledMemoryTurn =
        inputProvenance?.kind === "internal_system" &&
        (inputProvenance.sourceTool === "memory_search" ||
          inputProvenance.sourceTool === "memory_get");
      turnOrigin = classifySessionMessageOrigin(message, turnOrigin);
    }
    if (message.role === "user" && hasInterSessionUserProvenance(message)) {
      continue;
    }
    // Observers and turn provenance still see excluded messages; text export does not.
    if (
      insideHeartbeatTurn ||
      insideRecalledMemoryTurn ||
      generatedByDreamingNarrative ||
      generatedByCronRun
    ) {
      continue;
    }
    if ("display" in message && message.display === false) {
      continue;
    }
    const rawText = prepareAssistantTranscriptText(
      message,
      collectRawSessionText(message.content) ?? undefined,
    );
    if (rawText === undefined) {
      continue;
    }

    // User text is not trusted archive-wide provenance. Per-message sanitization
    // drops cron prompts without clearing unrelated content from the archive.
    const text = sanitizeSessionText(rawText, message.role);
    if (!text) {
      continue;
    }
    const label = message.role === "user" ? "User" : "Assistant";
    const renderedLines = renderSessionExportLines(label, text);
    const memoryProvenance: MemoryEntryProvenance = {
      originClass: classifySessionMessageOrigin(message, turnOrigin),
      sessionKind,
      observedAt: Math.max(0, Math.floor(timestampMs || mtimeMs)),
    };
    collected.push(...renderedLines);
    lineMap.push(...renderedLines.map(() => jsonlIdx + 1));
    messageTimestampsMs.push(...renderedLines.map(() => timestampMs));
    lineProvenance.push(...renderedLines.map(() => memoryProvenance));
  }
  const content = collected.join("\n");
  const entry: SessionFileEntry = {
    path: memoryPath,
    absPath,
    mtimeMs,
    ...(sqliteSource ? { revisionMs: sqliteSource.revisionMs } : {}),
    size,
    hash: hashSessionEntrySnapshot({
      content,
      lineMap,
      messageTimestampsMs,
      lineProvenance,
      resetRecallCutoff: sqliteSource?.resetRecallCutoff ?? { state: "absent" },
    }),
    content,
    lineMap,
    messageTimestampsMs,
    lineProvenance,
    sessionKind,
    ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(generatedByCronRun ? { generatedByCronRun: true } : {}),
  };
  return attachSessionEntryResetRecallCutoff(
    entry,
    sqliteSource?.resetRecallCutoff ?? { state: "absent" },
  );
}
