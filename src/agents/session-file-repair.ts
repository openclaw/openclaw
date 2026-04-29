import fs from "node:fs/promises";
import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "./stream-message-shared.js";

type RepairReport = {
  repaired: boolean;
  droppedLines: number;
  rewrittenAssistantMessages?: number;
  droppedBlankUserMessages?: number;
  rewrittenUserMessages?: number;
  droppedTrailingErrorEntries?: number;
  backupPath?: string;
  reason?: string;
};

// Persisted assistant entries with `content: []` (written by older builds when
// a stream/provider error fired before any block was produced) are valid JSON
// but not valid for AWS Bedrock Converse replay; rewriting them on disk lets a
// poisoned session recover across gateway restarts instead of needing a fresh
// session. The sentinel text is shared with stream-message-shared.ts and
// replay-history.ts so a session repaired offline reads byte-identically to a
// live stream-error turn — that byte-identity is what makes the repair pass
// idempotent (a healed entry is then indistinguishable from a fresh one).

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
  // Only error turns are eligible for on-disk rewrite. A clean stop with
  // empty content (silent-reply / NO_REPLY path documented in
  // run.empty-error-retry.test.ts) is a valid historical assistant turn —
  // mutating it into a synthetic failure message would permanently corrupt
  // the transcript and replay fabricated failure text on future requests.
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

// A trailing assistant entry — either still empty (`content: []`) or already
// healed to the sentinel by a prior repair pass — that ended in `error` is
// unsafe to keep at the tail of the transcript. Anthropic Messages (and
// equivalent provider APIs) reject conversations that do not end on a user
// turn with `"This model does not support assistant message prefill. The
// conversation must end with a user message."`, so when a heartbeat or
// resume path replays such a session it loops on the same 400 forever and
// each failed attempt appends *another* errored-empty assistant entry that
// the next repair pass also cannot fix in place. Dropping the trailing
// errored entry restores the "ends with user" invariant; mid-transcript
// errored entries are still rewritten in place because they have a real
// user turn after them and the sentinel keeps the transcript readable.
function isTrailingDroppableAssistantErrorEntry(entry: unknown): boolean {
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
  if (message.role !== "assistant" || message.stopReason !== "error") {
    return false;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  if (message.content.length === 0) {
    return true;
  }
  // Already-healed sentinel form written by a prior repair pass.
  if (message.content.length === 1) {
    const block = message.content[0] as { type?: unknown; text?: unknown } | undefined;
    if (
      block &&
      typeof block === "object" &&
      block.type === "text" &&
      block.text === STREAM_ERROR_FALLBACK_TEXT
    ) {
      return true;
    }
  }
  return false;
}

function isMessageEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  return (entry as { type?: unknown }).type === "message";
}

type UserEntryRepair =
  | { kind: "drop" }
  | { kind: "rewrite"; entry: SessionMessageEntry }
  | { kind: "keep" };

function repairUserEntryWithBlankTextContent(entry: SessionMessageEntry): UserEntryRepair {
  const content = entry.message.content;
  if (typeof content === "string") {
    return content.trim() ? { kind: "keep" } : { kind: "drop" };
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
    return { kind: "drop" };
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
  droppedTrailingErrorEntries: number;
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
  if (params.droppedTrailingErrorEntries > 0) {
    parts.push(
      `dropped ${params.droppedTrailingErrorEntries} trailing errored assistant entry(ies)`,
    );
  }
  // Caller only invokes this once at least one counter is non-zero, so the
  // empty-array branch is unreachable in production. Kept for defensive output.
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
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
  const entries: unknown[] = [];
  let droppedLines = 0;
  let rewrittenAssistantMessages = 0;
  let droppedBlankUserMessages = 0;
  let rewrittenUserMessages = 0;
  let droppedTrailingErrorEntries = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
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

  // Drop trailing errored-empty (or sentinel-rewritten) assistant entries so
  // the on-disk transcript ends on a user turn. Walking from the end avoids
  // touching mid-transcript errored entries (those keep the sentinel form so
  // the historical timeline stays readable). Non-message tail entries
  // (compaction, model_change, branch_summary, thinking_level_change, etc.)
  // are skipped over: they aren't sent to the model and don't break the
  // "ends with user" invariant by themselves.
  while (entries.length > 0) {
    const tail = entries[entries.length - 1];
    if (!isMessageEntry(tail)) {
      break;
    }
    if (!isTrailingDroppableAssistantErrorEntry(tail)) {
      break;
    }
    entries.pop();
    if (rewrittenAssistantMessages > 0) {
      // The trailing entry was just rewritten by the loop above; back the
      // counter out so the warn summary reflects that we dropped it instead
      // of leaving it healed in place.
      rewrittenAssistantMessages -= 1;
    }
    droppedTrailingErrorEntries += 1;
  }

  if (
    droppedLines === 0 &&
    rewrittenAssistantMessages === 0 &&
    droppedBlankUserMessages === 0 &&
    rewrittenUserMessages === 0 &&
    droppedTrailingErrorEntries === 0
  ) {
    return { repaired: false, droppedLines: 0 };
  }

  const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  const tmpPath = `${sessionFile}.repair-${process.pid}-${Date.now()}.tmp`;
  try {
    const stat = await fs.stat(sessionFile).catch(() => null);
    await fs.writeFile(backupPath, content, "utf-8");
    if (stat) {
      await fs.chmod(backupPath, stat.mode);
    }
    await fs.writeFile(tmpPath, cleaned, "utf-8");
    if (stat) {
      await fs.chmod(tmpPath, stat.mode);
    }
    await fs.rename(tmpPath, sessionFile);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch (cleanupErr) {
      params.warn?.(
        `session file repair cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"} (${path.basename(
          tmpPath,
        )})`,
      );
    }
    return {
      repaired: false,
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      droppedTrailingErrorEntries,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  params.warn?.(
    `session file repaired: ${buildRepairSummaryParts({
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      droppedTrailingErrorEntries,
    })} (${path.basename(sessionFile)})`,
  );
  return {
    repaired: true,
    droppedLines,
    rewrittenAssistantMessages,
    droppedBlankUserMessages,
    rewrittenUserMessages,
    droppedTrailingErrorEntries,
    backupPath,
  };
}
