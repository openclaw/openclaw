import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "./stream-message-shared.js";

/** Placeholder for blank user messages — preserves the user turn so strict
 * providers that require at least one user message don't reject the transcript. */
export const BLANK_USER_FALLBACK_TEXT = "(continue)";

type RepairReport = {
  repaired: boolean;
  droppedLines: number;
  rewrittenAssistantMessages?: number;
  droppedBlankUserMessages?: number;
  rewrittenUserMessages?: number;
  droppedOrphanForkEntries?: number;
  backupPath?: string;
  reason?: string;
};

// The sentinel text is shared with stream-message-shared.ts and
// replay-history.ts so a repaired entry is byte-identical to a live
// stream-error turn, keeping the repair pass idempotent.

type SessionMessageEntry = {
  type: "message";
  message: { role: string; content?: unknown } & Record<string, unknown>;
} & Record<string, unknown>;

function isSessionHeader(entry: unknown): entry is { type: string; id: string } {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}

/**
 * Detect a `type: "message"` entry whose `message.role` is missing, `null`, or
 * not a non-empty string. Such entries surface in the wild as "null role"
 * JSONL corruption (e.g. #77228 reported transcripts that contained 935+
 * entries with null roles after an earlier failure). They cannot be replayed
 * to any provider — every provider router branches on `message.role` — and
 * preserving them through repair just relocates the corruption from the
 * original file into the post-repair file. Treat them as malformed lines:
 * drop during repair so the cleaned transcript no longer carries them.
 */
function isStructurallyInvalidMessageEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message") {
    return false;
  }
  if (!record.message || typeof record.message !== "object") {
    return true;
  }
  const role = (record.message as { role?: unknown }).role;
  return typeof role !== "string" || role.trim().length === 0;
}

function isAssistantEntryWithEmptyContent(entry: unknown): entry is SessionMessageEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
  };
  if (message.role !== "assistant") {
    return false;
  }
  if (!Array.isArray(message.content) || message.content.length !== 0) {
    return false;
  }
  // Only error stops — clean stops with empty content (NO_REPLY path) are
  // valid silent replies that must not be overwritten with synthetic text.
  return message.stopReason === "error";
}

function rewriteAssistantEntryWithEmptyContent(entry: SessionMessageEntry): SessionMessageEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
    },
  };
}

type UserEntryRepair =
  | { kind: "drop" }
  | { kind: "rewrite"; entry: SessionMessageEntry }
  | { kind: "keep" };

function repairUserEntryWithBlankTextContent(entry: SessionMessageEntry): UserEntryRepair {
  const content = entry.message.content;
  if (typeof content === "string") {
    if (content.trim()) {
      return { kind: "keep" };
    }
    return {
      kind: "rewrite",
      entry: {
        ...entry,
        message: {
          ...entry.message,
          content: BLANK_USER_FALLBACK_TEXT,
        },
      },
    };
  }
  if (!Array.isArray(content)) {
    return { kind: "keep" };
  }

  let touched = false;
  const nextContent = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    if ((block as { type?: unknown }).type !== "text") {
      return true;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length > 0) {
      return true;
    }
    touched = true;
    return false;
  });
  if (nextContent.length === 0) {
    return {
      kind: "rewrite",
      entry: {
        ...entry,
        message: {
          ...entry.message,
          content: [{ type: "text", text: BLANK_USER_FALLBACK_TEXT }],
        },
      },
    };
  }
  if (!touched) {
    return { kind: "keep" };
  }
  return {
    kind: "rewrite",
    entry: {
      ...entry,
      message: {
        ...entry.message,
        content: nextContent,
      },
    },
  };
}

function buildRepairSummaryParts(params: {
  droppedLines: number;
  rewrittenAssistantMessages: number;
  droppedBlankUserMessages: number;
  rewrittenUserMessages: number;
  droppedOrphanForkEntries: number;
}): string {
  const parts: string[] = [];
  if (params.droppedLines > 0) {
    parts.push(`dropped ${params.droppedLines} malformed line(s)`);
  }
  if (params.rewrittenAssistantMessages > 0) {
    parts.push(`rewrote ${params.rewrittenAssistantMessages} assistant message(s)`);
  }
  if (params.droppedBlankUserMessages > 0) {
    parts.push(`dropped ${params.droppedBlankUserMessages} blank user message(s)`);
  }
  if (params.rewrittenUserMessages > 0) {
    parts.push(`rewrote ${params.rewrittenUserMessages} user message(s)`);
  }
  if (params.droppedOrphanForkEntries > 0) {
    parts.push(`dropped ${params.droppedOrphanForkEntries} orphan fork entry/entries`);
  }
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

type ParentLinkedEntry = {
  id: string;
  parentId: string | null;
  type: string | null;
};

/**
 * Compaction-retry losers always carry the canonical `type: "compaction"`
 * discriminator (the same one `manual-compaction-boundary.ts` and
 * `pi-embedded-runner-extraparams.ts` write at the source site). Restricting
 * the orphan-fork repair to entries with this discriminator is what keeps a
 * legitimate non-compaction leaf branch — a normal message that happens to
 * be a tree leaf next to a continued sibling — out of the drop set.
 */
const COMPACTION_RETRY_LOSER_TYPE = "compaction";

function readParentLinkedEntry(entry: unknown): ParentLinkedEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as { type?: unknown; id?: unknown; parentId?: unknown };
  if (record.type === "session") {
    return null;
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  if (!Object.hasOwn(record, "parentId")) {
    return null;
  }
  const parentId = record.parentId;
  const type = typeof record.type === "string" && record.type.length > 0 ? record.type : null;
  if (parentId === null) {
    return { id: record.id, parentId: null, type };
  }
  if (typeof parentId !== "string" || parentId.length === 0) {
    return null;
  }
  return { id: record.id, parentId, type };
}

/**
 * Detect parentId forks created by the compaction retry path: same parentId,
 * one `type: "compaction"` event becomes a dead-end with no descendants while
 * another `type: "compaction"` event is adopted as the continuation. Drop the
 * dead-end loser(s) so downstream causal-order walkers don't break at the
 * fork. (#48810)
 *
 * Conservative rules — only drop an entry when ALL of the following hold:
 * 1. the entry is `type: "compaction"`, AND
 * 2. it shares parentId with at least one other compaction sibling, AND
 * 3. the entry itself has zero descendants in the parent-linked graph, AND
 * 4. exactly one of its compaction siblings under the same parentId has
 *    descendants (the retry winner).
 *
 * Generic non-compaction entries are NEVER dropped here — a valid side
 * branch can naturally be a leaf next to a continued branch (per
 * clawsweeper-bot review on #79635), and only the compaction-retry path is
 * known to produce the duplicate-sibling-with-shared-parentId shape this
 * repair targets. If multiple compaction siblings have descendants, treat
 * the group as a deliberate fork and keep every entry. If no compaction
 * sibling has descendants, also keep every entry; we can't safely pick.
 */
function detectAndDropOrphanForkEntries(entries: unknown[]): {
  entries: unknown[];
  droppedCount: number;
} {
  if (entries.length === 0) {
    return { entries, droppedCount: 0 };
  }
  const parentLinked = new Map<number, ParentLinkedEntry>();
  for (let i = 0; i < entries.length; i += 1) {
    const linked = readParentLinkedEntry(entries[i]);
    if (linked) {
      parentLinked.set(i, linked);
    }
  }
  if (parentLinked.size === 0) {
    return { entries, droppedCount: 0 };
  }

  const childrenByParentId = new Map<string, number[]>();
  const idToIndex = new Map<string, number>();
  for (const [index, linked] of parentLinked) {
    if (linked.parentId !== null) {
      const bucket = childrenByParentId.get(linked.parentId) ?? [];
      bucket.push(index);
      childrenByParentId.set(linked.parentId, bucket);
    }
    idToIndex.set(linked.id, index);
  }

  const subtreeSize = new Map<string, number>();
  for (const id of idToIndex.keys()) {
    subtreeSize.set(id, 0);
  }
  const seen = new Set<string>();
  function computeSubtreeSize(id: string): number {
    const cached = subtreeSize.get(id);
    if (cached === undefined || seen.has(id)) {
      return cached ?? 0;
    }
    seen.add(id);
    const kids = childrenByParentId.get(id) ?? [];
    let total = 0;
    for (const childIndex of kids) {
      const child = parentLinked.get(childIndex);
      if (!child) {
        continue;
      }
      total += 1 + computeSubtreeSize(child.id);
    }
    subtreeSize.set(id, total);
    return total;
  }
  for (const id of idToIndex.keys()) {
    computeSubtreeSize(id);
  }

  const indicesToDrop = new Set<number>();
  for (const [, siblingIndices] of childrenByParentId) {
    if (siblingIndices.length < 2) {
      continue;
    }

    // Collect compaction-typed siblings only — a generic leaf next to a
    // continued generic branch is a legitimate side branch and must not be
    // touched. The drop is restricted to compaction-vs-compaction same-
    // parentId forks, which is the exact shape #48810 reports.
    const compactionSiblings: number[] = [];
    let compactionWinners = 0;
    for (const idx of siblingIndices) {
      const linked = parentLinked.get(idx);
      if (!linked || linked.type !== COMPACTION_RETRY_LOSER_TYPE) {
        continue;
      }
      compactionSiblings.push(idx);
      if ((subtreeSize.get(linked.id) ?? 0) > 0) {
        compactionWinners += 1;
      }
    }

    if (compactionSiblings.length < 2 || compactionWinners !== 1) {
      // Need at least 2 compaction siblings AND exactly one with descendants
      // to identify the loser unambiguously. Anything else is either a
      // single compaction event (no fork at all), a deliberate compaction
      // fan-out (multiple winners), or a not-yet-resolved candidate group
      // (no winner). All are kept untouched.
      continue;
    }

    for (const idx of compactionSiblings) {
      const linked = parentLinked.get(idx);
      if (!linked) {
        continue;
      }
      if ((subtreeSize.get(linked.id) ?? 0) === 0) {
        indicesToDrop.add(idx);
      }
    }
  }

  if (indicesToDrop.size === 0) {
    return { entries, droppedCount: 0 };
  }
  const next: unknown[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (!indicesToDrop.has(i)) {
      next.push(entries[i]);
    }
  }
  return { entries: next, droppedCount: indicesToDrop.size };
}

export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { repaired: false, droppedLines: 0, reason: "missing session file" };
  }

  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return { repaired: false, droppedLines: 0, reason: "missing session file" };
    }
    const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
    params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
    return { repaired: false, droppedLines: 0, reason };
  }

  const lines = content.split(/\r?\n/);
  let entries: unknown[] = [];
  let droppedLines = 0;
  let rewrittenAssistantMessages = 0;
  let droppedBlankUserMessages = 0;
  let rewrittenUserMessages = 0;
  let droppedOrphanForkEntries = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      if (isStructurallyInvalidMessageEntry(entry)) {
        // Drop "null role" / missing-role message entries the same way we
        // drop unparseable JSONL: they cannot be replayed to any provider
        // and preserving them through repair just relocates the corruption
        // into the post-repair file (#77228: 935+ null-role entries
        // surviving the auto-repair pass).
        droppedLines += 1;
        continue;
      }
      if (isAssistantEntryWithEmptyContent(entry)) {
        entries.push(rewriteAssistantEntryWithEmptyContent(entry));
        rewrittenAssistantMessages += 1;
        continue;
      }
      if (
        entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "message" &&
        typeof (entry as { message?: unknown }).message === "object" &&
        ((entry as { message: { role?: unknown } }).message?.role ?? undefined) === "user"
      ) {
        const repairedUser = repairUserEntryWithBlankTextContent(entry as SessionMessageEntry);
        if (repairedUser.kind === "drop") {
          droppedBlankUserMessages += 1;
          continue;
        }
        if (repairedUser.kind === "rewrite") {
          entries.push(repairedUser.entry);
          rewrittenUserMessages += 1;
          continue;
        }
      }
      entries.push(entry);
    } catch {
      droppedLines += 1;
    }
  }

  if (entries.length === 0) {
    return { repaired: false, droppedLines, reason: "empty session file" };
  }

  if (!isSessionHeader(entries[0])) {
    params.warn?.(
      `session file repair skipped: invalid session header (${path.basename(sessionFile)})`,
    );
    return { repaired: false, droppedLines, reason: "invalid session header" };
  }

  const forkRepair = detectAndDropOrphanForkEntries(entries);
  if (forkRepair.droppedCount > 0) {
    entries = forkRepair.entries;
    droppedOrphanForkEntries = forkRepair.droppedCount;
  }

  if (
    droppedLines === 0 &&
    rewrittenAssistantMessages === 0 &&
    droppedBlankUserMessages === 0 &&
    rewrittenUserMessages === 0 &&
    droppedOrphanForkEntries === 0
  ) {
    return { repaired: false, droppedLines: 0 };
  }

  const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  try {
    const stat = await fs.stat(sessionFile).catch(() => null);
    await fs.writeFile(backupPath, content, "utf-8");
    if (stat) {
      await fs.chmod(backupPath, stat.mode);
    }
    await replaceFileAtomic({
      filePath: sessionFile,
      content: cleaned,
      preserveExistingMode: true,
      tempPrefix: `${path.basename(sessionFile)}.repair`,
    });
  } catch (err) {
    return {
      repaired: false,
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      droppedOrphanForkEntries,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  params.debug?.(
    `session file repaired: ${buildRepairSummaryParts({
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      droppedOrphanForkEntries,
    })} (${path.basename(sessionFile)})`,
  );
  return {
    repaired: true,
    droppedLines,
    rewrittenAssistantMessages,
    droppedBlankUserMessages,
    rewrittenUserMessages,
    droppedOrphanForkEntries,
    backupPath,
  };
}
