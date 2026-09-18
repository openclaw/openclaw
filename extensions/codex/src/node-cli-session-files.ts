// Codex plugin module reads a codex-home's rollout files into session summaries.
import fs from "node:fs/promises";
import path from "node:path";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  type JsonlHeadWindow,
  readJsonlHead,
  readJsonlTail,
  visitJsonlLines,
} from "./jsonl-lines.js";

/**
 * The head window carries `session_meta` (id + cwd) and the opening messages. Real rollouts embed
 * the whole instruction set in `session_meta`; the largest observed here is ~149 KiB, so this keeps
 * roughly 3x headroom over that record alone.
 */
const SESSION_FILE_HEAD_SCAN_BYTES = 512 * 1024;
/**
 * One escalation for a `session_meta` record too large for the head window. This is a bound, not a
 * guarantee: a `session_meta` larger than this still yields no complete first record, so `cwd` is
 * reported as unknown rather than read at unbounded cost.
 */
const SESSION_FILE_HEAD_SCAN_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The tail window usually supplies the final record `timestamp` and any late user message. A final
 * record larger than this leaves no complete line in the window, in which case `updatedAt` falls
 * back to file mtime.
 */
const SESSION_FILE_TAIL_SCAN_BYTES = 256 * 1024;
/** Below this size head+tail would already cover the file, so read it once and keep counts exact. */
const SESSION_FILE_FULL_READ_BYTES = SESSION_FILE_HEAD_SCAN_BYTES + SESSION_FILE_TAIL_SCAN_BYTES;
/** Rollouts scanned past `limit` to absorb mtime vs. record-`timestamp` ordering skew. */
const SESSION_FILE_SCAN_HEADROOM = 20;
/**
 * Most bytes one `readSessionFileSummary` can read: the initial head window, one escalation for an
 * oversized `session_meta`, and the tail window. The scan budget below is checked between files, so
 * this is exactly how far past that budget a scan can run.
 */
export const SESSION_FILE_MAX_SUMMARY_READ_BYTES =
  SESSION_FILE_HEAD_SCAN_BYTES + SESSION_FILE_HEAD_SCAN_MAX_BYTES + SESSION_FILE_TAIL_SCAN_BYTES;
/**
 * A filter can match `cwd` or a message preview, which are only known after hydration, so a filtered
 * listing has to open rollouts to answer it. It walks them in candidate order and stops as soon as
 * it holds enough matches to fill the requested page, so the common "my recent session in /repo"
 * case costs a handful of files. When matches are sparse it keeps going until one of the two
 * ceilings below is reached, and then says so — see `searchTruncated`. Reading every rollout
 * unconditionally is not an option even with windowed reads: on a 2928-rollout codex-home the
 * per-file windows alone total ~877 MB and 4.2 s warm, measured. 256 MiB keeps the worst case near a
 * second of reads at the ~209 MB/s that measurement implies, leaving wide margin under the 15 s
 * invoke timeout. It searches a codex-home of a few hundred rollouts end to end; only a backlog past
 * that gets cut.
 *
 * The budget is charged the bytes each summary read actually reported, escalations included, and is
 * checked before opening the next rollout — so this scan reads at most
 * `FILTERED_SESSION_SCAN_BUDGET_BYTES + SESSION_FILE_MAX_SUMMARY_READ_BYTES`. It bounds *this* scan
 * only. `readHistorySessions` and `hydrateSessionFiles` run before it and read outside it, so this
 * is not a cap on what the whole list command reads.
 */
const FILTERED_SESSION_SCAN_BUDGET_BYTES = 256 * 1024 * 1024;
/** Companion ceiling to the byte budget, so a home full of tiny rollouts cannot spend it on syscalls. */
const FILTERED_SESSION_FILE_SCAN_CAP = 2_000;

export type CodexCliSessionSummary = {
  sessionId: string;
  updatedAt?: string;
  lastMessage?: string;
  cwd?: string;
  sessionFile?: string;
  messageCount: number;
  /**
   * Set when the rollout was too large to read whole, so a middle span went unread: `messageCount`
   * counts only the scanned head/tail windows, `lastMessage` is the last user message inside them
   * rather than necessarily the last one in the file, and `updatedAt` may come from file mtime.
   */
  partialScan?: boolean;
};

export type CodexCliSessionFile = {
  file: string;
  basename: string;
  mtimeMs: number;
  size: number;
};

export function matchesSessionFilter(session: CodexCliSessionSummary, filter: string): boolean {
  if (!filter) {
    return true;
  }
  return [session.sessionId, session.cwd, session.lastMessage].some((value) =>
    value?.toLowerCase().includes(filter),
  );
}

export async function readHistorySessions(
  codexHome: string,
): Promise<Map<string, CodexCliSessionSummary>> {
  const summaries = new Map<string, CodexCliSessionSummary>();
  const historyPath = path.join(codexHome, "history.jsonl");
  const result = await visitJsonlLines(historyPath, (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.session_id !== "string") {
      return;
    }
    const sessionId = parsed.session_id.trim();
    if (!sessionId) {
      return;
    }
    const entry = summaries.get(sessionId) ?? {
      sessionId,
      messageCount: 0,
    };
    entry.messageCount += 1;
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      entry.lastMessage = truncateText(parsed.text.trim(), 140);
    }
    if (typeof parsed.ts === "number") {
      entry.updatedAt = timestampMsToIsoString(parsed.ts * 1000) ?? entry.updatedAt;
    }
    summaries.set(sessionId, entry);
  });
  if (!result.ok) {
    return new Map();
  }
  return summaries;
}

/**
 * Attach a rollout file and its `cwd` to each session `history.jsonl` already named. This reads one
 * head window per history-backed session and is **not** charged against the filtered scan budget:
 * its cost scales with the number of distinct sessions in `history.jsonl`, not with the filter.
 */
export async function hydrateSessionFiles(
  summaries: Map<string, CodexCliSessionSummary>,
  files: CodexCliSessionFile[],
): Promise<void> {
  if (summaries.size === 0) {
    return;
  }
  const pending = new Set(summaries.keys());
  for (const file of files) {
    const sessionId = [...pending].find((id) => file.basename.includes(id));
    if (!sessionId) {
      continue;
    }
    const entry = summaries.get(sessionId);
    if (!entry) {
      continue;
    }
    entry.sessionFile = file.file;
    const firstLine = (await readFirstLine(file.file)) ?? "";
    const cwd = readSessionMetaCwd(firstLine);
    if (cwd) {
      entry.cwd = cwd;
    }
    pending.delete(sessionId);
    if (pending.size === 0) {
      return;
    }
  }
}

/**
 * Pick the rollouts worth hydrating. The listing is sorted newest-first and sliced to `limit`, so
 * scanning every rollout only to discard all but a handful makes list cost scale with total bytes
 * on disk.
 *
 * mtime is a heuristic proxy for recency, not a proof of it: rollouts are append-only, but a copy,
 * restore, or `touch` rewrites mtime without changing the records, so the candidate order can
 * differ from the order by last record `timestamp`. `SESSION_FILE_SCAN_HEADROOM` absorbs small
 * skew; a wholesale mtime rewrite can still hide a session from an unfiltered listing. Filtering by
 * session id stays reliable regardless, because ids appear in the filename and sort first.
 *
 * A filtered request gets every rollout as a candidate, in filename-match-then-recency order, up to
 * the file ceiling; the caller decides how far down that list it actually reads.
 */
function selectSessionFilesToScan(
  files: CodexCliSessionFile[],
  filter: string,
  limit: number,
): CodexCliSessionFile[] {
  const byRecency = files.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  if (!filter) {
    return byRecency.slice(0, limit + SESSION_FILE_SCAN_HEADROOM);
  }
  const named = byRecency.filter((entry) => entry.basename.toLowerCase().includes(filter));
  const rest = byRecency.filter((entry) => !entry.basename.toLowerCase().includes(filter));
  return [...named, ...rest].slice(0, FILTERED_SESSION_FILE_SCAN_CAP);
}

export type SessionFileScanOutcome = {
  scannedFileCount: number;
  /**
   * Rollouts whose summary was built from windows that skipped a middle span and which then failed
   * the filter. The filter term could sit in a record inside that span, so each one is a session
   * the search may be hiding — a file being *opened* is not the same as its content being *read*.
   */
  unreadSpanCount: number;
  searchTruncated: boolean;
};

/**
 * Hydrate rollouts in candidate order, stopping as early as the request allows.
 *
 * Unfiltered, the stop is the recency page `selectSessionFilesToScan` already hands back. Filtered,
 * the stop is the first of: enough matches to fill the page, the scan budget, or the candidate list
 * running out. Only the last of those searched the whole corpus, so anything else reports
 * `searchTruncated` — the caller is told its search was cut rather than left to read a short list as
 * an exhaustive one.
 *
 * The match early-out is a heuristic, not a proof that nothing better was left unread. Candidates
 * are ordered by filename match and then mtime, while the listing is finally sorted by the
 * `updatedAt` recovered from records, so a rollout the scan stopped short of can still sort above
 * one it already matched. `SESSION_FILE_SCAN_HEADROOM` only absorbs small skew, and history-derived
 * matches counted before the loop are in no file order at all. `searchTruncated` is the signal that
 * holds in every one of those cases; the ordering itself is not guaranteed.
 *
 * Opening every candidate is still not a complete search. A rollout too large to read whole is
 * summarized from a head and a tail window, so a filter term in the skipped middle is invisible and
 * the row is dropped as a non-match. `unreadSpanCount` counts exactly those drops and also sets
 * `searchTruncated`, so "every file was opened" can never by itself report a search as complete.
 */
export async function hydrateSessionsFromSessionFiles(
  summaries: Map<string, CodexCliSessionSummary>,
  files: CodexCliSessionFile[],
  filter: string,
  limit: number,
): Promise<SessionFileScanOutcome> {
  const candidates = selectSessionFilesToScan(files, filter, limit);
  // The page is `limit` long; the headroom is the same allowance for mtime vs. record-`timestamp`
  // skew that `SESSION_FILE_SCAN_HEADROOM` exists for, and bounds the skew it covers, not the skew
  // that can occur.
  const enoughMatches = limit + SESSION_FILE_SCAN_HEADROOM;
  const matched = new Set<string>();
  if (filter) {
    for (const [sessionId, summary] of summaries) {
      if (matchesSessionFilter(summary, filter)) {
        matched.add(sessionId);
      }
    }
  }
  let scannedFileCount = 0;
  let spentBytes = 0;
  let unreadSpanCount = 0;
  // Every exit reports the same two independent reasons a filtered search can be incomplete: files
  // never opened, and opened files whose middle went unread. Routing them through one place is what
  // keeps a new early exit from quietly reintroducing an unqualified "complete" answer.
  const finish = (filesLeftUnopened: boolean): SessionFileScanOutcome => ({
    scannedFileCount,
    unreadSpanCount,
    searchTruncated: filter ? filesLeftUnopened || unreadSpanCount > 0 : false,
  });
  for (const file of candidates) {
    if (filter) {
      if (matched.size >= enoughMatches) {
        return finish(scannedFileCount < files.length);
      }
      // Charge what the previous reads reported, not what their file sizes suggested. A `min(size,
      // head+tail)` estimate silently undercounts the 4 MiB `session_meta` escalation by more than
      // six times, so a home full of oversized metadata records used to run gigabytes past a budget
      // stated in hundreds of megabytes. Checking between files keeps the overshoot to one file.
      if (scannedFileCount > 0 && spentBytes >= FILTERED_SESSION_SCAN_BUDGET_BYTES) {
        return finish(true);
      }
    }
    scannedFileCount += 1;
    const read = await readSessionFileSummary(file);
    spentBytes += read.bytesRead;
    const summary = read.summary;
    if (!summary) {
      continue;
    }
    const existing = summaries.get(summary.sessionId);
    // `messageCount` and its partial marker describe one scan, so take both from the same source.
    const counted = existing ?? summary;
    const merged: CodexCliSessionSummary = {
      ...summary,
      ...existing,
      cwd: existing?.cwd ?? summary.cwd,
      sessionFile: existing?.sessionFile ?? summary.sessionFile,
      updatedAt: existing?.updatedAt ?? summary.updatedAt,
      lastMessage: existing?.lastMessage ?? summary.lastMessage,
      messageCount: counted.messageCount,
      partialScan: counted.partialScan,
    };
    summaries.set(summary.sessionId, merged);
    if (filter) {
      if (matchesSessionFilter(merged, filter)) {
        matched.add(summary.sessionId);
      } else if (merged.partialScan === true) {
        // Dropped on the strength of a summary that skipped a span of this rollout. The record that
        // matches may be in that span, so this is an unanswered question, not a "no".
        unreadSpanCount += 1;
      }
    }
  }
  return finish(scannedFileCount < files.length);
}

/** A summary plus what reading it cost, so a caller can budget on measured I/O rather than a guess. */
type SessionFileSummaryRead = {
  summary: CodexCliSessionSummary | null;
  bytesRead: number;
};

async function readSessionFileSummary(file: CodexCliSessionFile): Promise<SessionFileSummaryRead> {
  const head = await readSessionMetaHead(
    file.file,
    file.size <= SESSION_FILE_FULL_READ_BYTES
      ? SESSION_FILE_FULL_READ_BYTES
      : SESSION_FILE_HEAD_SCAN_BYTES,
  );
  if (!head.window) {
    return { summary: null, bytesRead: head.bytesRead };
  }
  // Anchor the tail to where the head stopped. Without that floor an escalated head and the tail
  // can cover the same bytes, and every record in the overlap is counted twice. When the two
  // windows meet, the scan covered the file and stays exact even though it was read in pieces.
  const tail = await readJsonlTail(file.file, SESSION_FILE_TAIL_SCAN_BYTES, {
    notBefore: head.window.endOffset,
  });
  // A window that yielded no usable record still cost its bytes, so report them either way.
  const bytesRead = head.bytesRead + (tail?.bytesRead ?? 0);
  if (!tail) {
    return { summary: null, bytesRead };
  }
  // Two empty windows are not evidence that there is no session here. A `session_meta` past the
  // escalation and a final record past the tail window can both outrun their windows on a perfectly
  // readable rollout, and dropping it would hide the session from an exact-id search and leave
  // `/codex resume` unable to bind it. Fall through to the filename fallback instead and report the
  // result as a partial scan. A genuinely empty file still yields nothing.
  if (file.size === 0) {
    return { summary: null, bytesRead };
  }
  // The windows abut only when together they covered the file, so counts from them stay exact.
  const scannedWholeFile = tail.start <= head.window.endOffset;
  const headScan = scanSessionFileLines(head.window.lines);
  const tailScan = scanSessionFileLines(tail.lines);
  const sessionId =
    headScan.sessionId || tailScan.sessionId || readSessionIdFromFilename(file.file);
  if (!sessionId) {
    return { summary: null, bytesRead };
  }
  // A skipped middle means the head's newest timestamp predates records we never read, so mtime is
  // the better estimate. The tail can also yield no complete record when the final one is huge.
  const scannedUpdatedAt =
    tailScan.updatedAt ?? (scannedWholeFile ? headScan.updatedAt : undefined);
  return {
    bytesRead,
    summary: {
      sessionId,
      updatedAt: scannedUpdatedAt ?? new Date(file.mtimeMs).toISOString(),
      lastMessage: tailScan.lastMessage ?? headScan.lastMessage,
      cwd: headScan.cwd ?? tailScan.cwd,
      sessionFile: file.file,
      messageCount: headScan.messageCount + tailScan.messageCount,
      partialScan: scannedWholeFile ? undefined : true,
    },
  };
}

type CodexCliSessionFileScan = {
  sessionId: string;
  cwd?: string;
  updatedAt?: string;
  lastMessage?: string;
  messageCount: number;
};

function scanSessionFileLines(lines: string[]): CodexCliSessionFileScan {
  const scan: CodexCliSessionFileScan = { sessionId: "", messageCount: 0 };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    if (typeof parsed.timestamp === "string" && parsed.timestamp.trim()) {
      scan.updatedAt = parsed.timestamp.trim();
    }
    if (parsed.type === "session_meta" && isRecord(parsed.payload)) {
      if (typeof parsed.payload.id === "string" && parsed.payload.id.trim()) {
        scan.sessionId = parsed.payload.id.trim();
      }
      if (typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()) {
        scan.cwd = parsed.payload.cwd.trim();
      }
      continue;
    }
    const messageText = readResponseItemMessageText(parsed);
    if (messageText) {
      scan.messageCount += 1;
      scan.lastMessage = truncateText(messageText, 140);
    }
  }
  return scan;
}

export async function findSessionFiles(
  dir: string,
  maxDepth: number,
): Promise<CodexCliSessionFile[]> {
  if (maxDepth < 0) {
    return [];
  }
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: CodexCliSessionFile[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSessionFiles(entryPath, maxDepth - 1)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    // Ordering and read-window selection both need size/mtime, so stat once here instead of
    // opening every rollout to find out how recent it is.
    const stats = await fs.stat(entryPath).catch(() => undefined);
    if (!stats) {
      continue;
    }
    files.push({
      file: entryPath,
      basename: entry.name,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
  }
  return files;
}

function readSessionMetaCwd(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      return undefined;
    }
    return typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()
      ? parsed.payload.cwd.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function readResponseItemMessageText(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type !== "response_item" || !isRecord(parsed.payload)) {
    return undefined;
  }
  if (parsed.payload.type !== "message") {
    return undefined;
  }
  const role = typeof parsed.payload.role === "string" ? parsed.payload.role : "";
  if (role !== "user") {
    return undefined;
  }
  const content = Array.isArray(parsed.payload.content) ? parsed.payload.content : [];
  const parts = content.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const text =
      typeof entry.text === "string"
        ? entry.text
        : typeof entry.input_text === "string"
          ? entry.input_text
          : undefined;
    return text?.trim() ? [text.trim()] : [];
  });
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function readSessionIdFromFilename(file: string): string | undefined {
  const match = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
  return match?.[0];
}

/**
 * Read a head window wide enough to hold `session_meta`, escalating once when the first record did
 * not fit. Both the summary path and the history-backed `cwd` lookup go through this, so neither
 * loses `session_meta` on a rollout the other would have read: a `session_meta` between the two
 * bounds used to resolve depending on which path happened to open the file. The escalation is a
 * cost ceiling, not a guarantee — a `session_meta` wider than it still yields no complete record.
 */
async function readSessionMetaHead(
  file: string,
  initialBytes: number,
): Promise<{ window: JsonlHeadWindow | null; bytesRead: number }> {
  const head = await readJsonlHead(file, initialBytes);
  if (head && head.lines.length === 0 && !head.complete) {
    // The escalation re-reads from byte 0, so its bytes are on top of the first window's, not
    // instead of them. Reporting only the wider read would undercount every escalated file.
    const escalated = await readJsonlHead(file, SESSION_FILE_HEAD_SCAN_MAX_BYTES);
    return { window: escalated, bytesRead: head.bytesRead + (escalated?.bytesRead ?? 0) };
  }
  return { window: head, bytesRead: head?.bytesRead ?? 0 };
}

async function readFirstLine(file: string): Promise<string | undefined> {
  const head = await readSessionMetaHead(file, SESSION_FILE_HEAD_SCAN_BYTES);
  return head.window?.lines[0];
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, max - 3))}...`;
}
