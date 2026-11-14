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
  createSessionEntryHasher,
  parseSessionTimestampMs,
  renderSessionExportLines,
} from "./session-entry-projection.js";
import type {
  BuildSessionEntryOptions,
  SessionEntryPage,
  SessionEntrySnapshot,
  SessionEntrySummary,
  SessionFileState,
} from "./session-files.js";
import { classifySessionMessageOrigin } from "./session-provenance.js";
import {
  createSessionResetRecallCutoffTracker,
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
        records: Iterable<unknown>;
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

/** A rendered page; worker pages also carry the observed messages for host observers. */
export type SessionEntryRenderedPage = SessionEntryPage & {
  messages?: { message: unknown; observedAt: number }[];
};

export function readSessionEntryResetRecallCutoff(entry: object): SessionResetRecallCutoff {
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

export function attachSessionEntryResetRecallCutoff<Entry extends object>(
  entry: Entry,
  cutoff: SessionResetRecallCutoff,
): Entry {
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

/** Pages are bounded by rendered UTF-16 code units, about 1 MiB each. */
const SESSION_ENTRY_PAGE_CHARS = 512 * 1024;
const SESSION_ENTRY_PAGE_LINE_OVERHEAD_CHARS = 32;

export type SessionEntryRenderSink = {
  /** Also hash the first N lines, for checkpoints that compare an earlier export. */
  prefixLineCount?: number;
  /** Receives bounded pages of rendered lines in source order. */
  page?: (page: SessionEntryRenderedPage) => void | Promise<void>;
  /** Discards every page delivered so far; the next page starts at line 0 again. */
  reset?: () => void | Promise<void>;
  /** Carry observed messages in pages instead of invoking the caller's observer. */
  pageMessages?: boolean;
};

/** Render the worker's admitted snapshot without entering host discovery or restoration. */
export function renderSessionEntrySnapshot(
  absPath: string,
  opts: BuildSessionEntryOptions & { agentId: string; sessionId: string; storePath: string },
  snapshot: Omit<SessionEntrySnapshot, "events"> & { events: Iterable<unknown> },
  sink: SessionEntryRenderSink = {},
): Promise<SessionEntrySummary> {
  return renderSessionEntry(
    absPath,
    opts,
    {
      ...sqliteSessionFileState(absPath, opts, snapshot.stats, opts.updatedAtMs),
      kind: "sqlite",
      records: snapshot.events,
      sessionKey: snapshot.sessionKey,
    },
    sink,
  );
}

/**
 * Streams one transcript's memory export. Rendered text leaves in bounded pages; only per-message
 * line facts and event identities are retained, so the persisted hash needs no full content.
 */
export async function renderSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions,
  source: SessionEntrySource,
  sink: SessionEntryRenderSink = {},
): Promise<SessionEntrySummary> {
  const { mtimeMs, size, path: memoryPath } = source;
  const sqliteSource = source.kind === "sqlite" ? source : null;
  const raw = source.kind === "file" ? source.raw : "";
  const sessionStoreClassification = source.kind === "file" ? source.classification : null;
  const hasher = createSessionEntryHasher(sink.prefixLineCount);
  const resetRecall = sqliteSource ? createSessionResetRecallCutoffTracker() : undefined;
  const originClasses = new Set<MemoryOriginClass>();
  let page: SessionEntryRenderedPage | undefined;
  let pageChars = 0;
  let nextLine = 0;
  let deliveredPages = false;
  const openPage = () =>
    (page ??= {
      startLine: nextLine,
      lines: [],
      lineMap: [],
      messageTimestampsMs: [],
      lineProvenance: [],
    });
  const flushPage = async (force: boolean) => {
    if (!page || (!force && pageChars < SESSION_ENTRY_PAGE_CHARS)) {
      return;
    }
    const current = page;
    page = undefined;
    pageChars = 0;
    if (current.lines.length > 0 || current.messages?.length) {
      deliveredPages ||= current.lines.length > 0;
      await sink.page?.(current);
    }
  };
  const observe = sink.pageMessages
    ? (message: unknown, observedAt: number) => {
        const current = openPage();
        (current.messages ??= []).push({ message, observedAt });
        pageChars += JSON.stringify(message)?.length ?? 0;
      }
    : opts.onTranscriptMessage;
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
  // SQLite records arrive from an admitted snapshot or its fenced slices. Archives
  // retain raw line ordinals, including blank and malformed JSONL entries.
  const records = sqliteSource ? sqliteSource.records[Symbol.iterator]() : undefined;
  for (let jsonlIdx = 0, lineStart = 0; ; jsonlIdx++) {
    await yieldSessionEntryParseIfNeeded(jsonlIdx, parseYieldEveryLines);
    let record: unknown;
    if (records) {
      const next = records.next();
      if (next.done) {
        break;
      }
      record = next.value;
      resetRecall!.observe(record);
    } else {
      if (lineStart > raw.length) {
        break;
      }
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
      // Generated transcripts export nothing; earlier lines no longer belong to this entry.
      hasher.reset();
      originClasses.clear();
      nextLine = 0;
      if (page) {
        page.lines.length = 0;
        page.lineMap.length = 0;
        page.messageTimestampsMs.length = 0;
        page.lineProvenance.length = 0;
        page.startLine = 0;
      }
      if (deliveredPages) {
        deliveredPages = false;
        await sink.reset?.();
      }
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
    observe?.(message, Math.max(0, Math.floor(timestampMs || mtimeMs)));
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
      await flushPage(false);
      continue;
    }
    // Observers and turn provenance still see excluded messages; text export does not.
    if (
      insideHeartbeatTurn ||
      insideRecalledMemoryTurn ||
      generatedByDreamingNarrative ||
      generatedByCronRun ||
      ("display" in message && message.display === false)
    ) {
      await flushPage(false);
      continue;
    }
    const rawText = prepareAssistantTranscriptText(
      message,
      collectRawSessionText(message.content) ?? undefined,
    );
    // User text is not trusted archive-wide provenance. Per-message sanitization
    // drops cron prompts without clearing unrelated content from the archive.
    const text = rawText === undefined ? null : sanitizeSessionText(rawText, message.role);
    if (!text) {
      await flushPage(false);
      continue;
    }
    const label = message.role === "user" ? "User" : "Assistant";
    const renderedLines = renderSessionExportLines(label, text);
    const facts = {
      sourceLine: jsonlIdx + 1,
      timestampMs,
      provenance: {
        originClass: classifySessionMessageOrigin(message, turnOrigin),
        sessionKind,
        observedAt: Math.max(0, Math.floor(timestampMs || mtimeMs)),
      } satisfies MemoryEntryProvenance,
    };
    hasher.append(renderedLines, facts);
    if (renderedLines.length > 0) {
      originClasses.add(facts.provenance.originClass);
    }
    for (const line of renderedLines) {
      const current = openPage();
      current.lines.push(line);
      current.lineMap.push(facts.sourceLine);
      current.messageTimestampsMs.push(timestampMs);
      current.lineProvenance.push(facts.provenance);
      nextLine++;
      pageChars += line.length + SESSION_ENTRY_PAGE_LINE_OVERHEAD_CHARS;
      await flushPage(false);
    }
  }
  await flushPage(true);
  const resetRecallCutoff: SessionResetRecallCutoff = resetRecall?.current() ?? {
    state: "absent",
  };
  const { hash, prefixHash } = hasher.finish(resetRecallCutoff);
  const summary: SessionEntrySummary = {
    path: memoryPath,
    absPath,
    mtimeMs,
    ...(sqliteSource ? { revisionMs: sqliteSource.revisionMs } : {}),
    size,
    hash,
    ...(prefixHash ? { prefixHash } : {}),
    lineCount: hasher.lineCount,
    lineOriginClasses: [...originClasses].toSorted(),
    sessionKind,
    ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(generatedByCronRun ? { generatedByCronRun: true } : {}),
  };
  return attachSessionEntryResetRecallCutoff(summary, resetRecallCutoff);
}
