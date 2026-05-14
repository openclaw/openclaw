import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../../auto-reply/tokens.js";
import {
  type ClaudeCliFallbackSeed,
  readClaudeCliFallbackSeed,
} from "../../gateway/cli-session-history.js";

/** Maximum number of JSONL records to inspect before giving up. */
const SESSION_FILE_MAX_RECORDS = 500;
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");

function normalizeClaudeCliSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("/") || trimmed.includes("\\")) {
    return undefined;
  }
  return trimmed;
}

async function jsonlFileHasAssistantMessage(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }

    const fh = await fs.open(filePath, "r");
    try {
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf-8" }) });
      let recordCount = 0;
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        recordCount++;
        if (recordCount > SESSION_FILE_MAX_RECORDS) {
          break;
        }
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = obj as Record<string, unknown> | null;
        if ((rec?.message as Record<string, unknown> | undefined)?.role === "assistant") {
          return true;
        }
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * Check whether a session transcript file exists and contains at least one
 * assistant message, indicating that the SessionManager has flushed the
 * initial user+assistant exchange to disk.
 */
export async function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean> {
  return await jsonlFileHasAssistantMessage(sessionFile);
}

export async function claudeCliSessionTranscriptHasContent(params: {
  sessionId: string | undefined;
  homeDir?: string;
}): Promise<boolean> {
  const sessionId = normalizeClaudeCliSessionId(params.sessionId);
  if (!sessionId) {
    return false;
  }
  const homeDir = params.homeDir?.trim() || process.env.HOME || os.homedir();
  const projectsDir = path.join(homeDir, CLAUDE_PROJECTS_RELATIVE_DIR);
  let projectEntries: import("node:fs").Dirent[];
  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (await jsonlFileHasAssistantMessage(candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk a JSONL transcript and return whether the most recent assistant
 * message contains one or more `tool_use` content blocks whose `tool_use_id`
 * never received a matching `tool_result` later in the file.
 *
 * This is the "stuck resume" predicate: claude-cli's protocol requires that
 * every assistant `tool_use` be answered by a `tool_result` user message
 * before the conversation can advance. If the gateway dies mid-tool (e.g.
 * brew upgrade restart, claude-live-session no-output watchdog firing while
 * a tool is running, OOM, manual kickstart), the transcript is left with an
 * unanswered tool_use. On the next `claude --resume`, claude-cli sits
 * waiting for that tool_result, hits its own no-output timeout, and the
 * runtime kills it with `reason=abort`. The dispatcher then sees an empty
 * payload and emits NO_REPLY, looking to the user like the agent silently
 * ignored their message — same end-user symptom as the binding-flush
 * amnesia bug, different root cause.
 *
 * Detection has to look at the *last* assistant message specifically: an
 * orphan deeper in history might have been answered later by an out-of-
 * order tool_result, but a trailing orphan blocks all forward progress.
 */
async function jsonlFileHasOrphanedTrailingToolUse(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }

    const fh = await fs.open(filePath, "r");
    try {
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf-8" }) });
      // Track tool_use ids emitted by the *most recent* assistant message,
      // and tool_result ids that have been observed at any point thereafter.
      // An orphan = a tool_use id from the last assistant message that has
      // no matching tool_result anywhere later in the file.
      //
      // We do NOT cap at SESSION_FILE_MAX_RECORDS here — that cap is a
      // perf safety belt for the "any assistant message exists?" early-
      // exit predicate, where we can stop as soon as we see one. The
      // orphan check needs the *last* assistant message specifically; a
      // capped walk on a long-lived transcript could miss a trailing
      // orphan past record 500 (false negative → resume hangs) or miss
      // the resolution `tool_result` for an earlier orphan (false
      // positive → unnecessary reset). A claude-cli transcript is
      // bounded by claude-cli's own session-history retention, typically
      // O(10k) records; reading that volume of JSONL via streamed
      // readline is well under 100ms.
      let lastAssistantToolUseIds: Set<string> = new Set();
      let answeredToolResultIds: Set<string> = new Set();
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = obj as Record<string, unknown> | null;
        // Skip sidechain entries (Task-tool / subagent work) — claude-cli's
        // own resume path treats them as out-of-band, and the existing
        // history importer at gateway/cli-session-history.claude.ts:224
        // explicitly skips `entry.isSidechain === true`. A sidechain
        // tool_use that lacks a tool_result is NOT a forward-progress
        // blocker for the main conversation, so flagging it as an orphan
        // would falsely invalidate a healthy session.
        if (rec?.isSidechain === true) {
          continue;
        }
        const message = rec?.message as Record<string, unknown> | undefined;
        const role = message?.role;
        const content = message?.content;
        if (!Array.isArray(content)) {
          continue;
        }
        if (role === "assistant") {
          // Reset: only the LATEST assistant message's tool_use ids matter.
          // tool_result lookups still consider all later occurrences.
          const toolUseIds = new Set<string>();
          for (const item of content) {
            if (
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "tool_use"
            ) {
              const id = (item as Record<string, unknown>).id;
              if (typeof id === "string" && id) {
                toolUseIds.add(id);
              }
            }
          }
          lastAssistantToolUseIds = toolUseIds;
          // Don't reset answeredToolResultIds — a tool_result for a *prior*
          // tool_use observed before this assistant message doesn't help us,
          // but we keep the set monotonic to avoid edge cases. (Trailing
          // orphan is what we care about; older ones are inert.)
        } else if (role === "user") {
          // user messages can contain tool_result content blocks answering
          // earlier tool_use ids.
          for (const item of content) {
            if (
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "tool_result"
            ) {
              const useId = (item as Record<string, unknown>).tool_use_id;
              if (typeof useId === "string" && useId) {
                answeredToolResultIds.add(useId);
              }
            }
          }
        }
      }
      // Orphan = at least one id in last-assistant's tool_use set that is
      // NOT in the answered set.
      for (const id of lastAssistantToolUseIds) {
        if (!answeredToolResultIds.has(id)) {
          return true;
        }
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * Detect whether a candidate session id's on-disk transcript ends with a
 * trailing assistant `tool_use` that never received a matching `tool_result`.
 * Such a session can never make forward progress on resume — claude-cli will
 * sit waiting for the missing tool_result, hit its no-output watchdog, and
 * abort. See `jsonlFileHasOrphanedTrailingToolUse` for the protocol details.
 *
 * Returns false on probe failure (file missing, parse error, etc.) so we
 * never block resume on a transient I/O issue. The transcript-content
 * predicate runs first; if THAT fails we already invalidate via
 * missing-transcript, so a defensive false here only narrows the window
 * where we'd otherwise refuse a healthy session.
 */
export async function claudeCliSessionTranscriptHasOrphanedToolUse(params: {
  sessionId: string | undefined;
  homeDir?: string;
}): Promise<boolean> {
  const sessionId = normalizeClaudeCliSessionId(params.sessionId);
  if (!sessionId) {
    return false;
  }
  const homeDir = params.homeDir?.trim() || process.env.HOME || os.homedir();
  const projectsDir = path.join(homeDir, CLAUDE_PROJECTS_RELATIVE_DIR);
  let projectEntries: import("node:fs").Dirent[];
  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (await jsonlFileHasOrphanedTrailingToolUse(candidate)) {
      return true;
    }
  }
  return false;
}

export function resolveFallbackRetryPrompt(params: {
  body: string;
  isFallbackRetry: boolean;
  sessionHasHistory?: boolean;
  priorContextPrelude?: string;
}): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  const prelude = params.priorContextPrelude?.trim();
  if (!params.sessionHasHistory && !prelude) {
    return params.body;
  }
  // Even with persisted session history, fully replacing the body with a
  // generic "continue where you left off" message strips the original task
  // from the fallback model's view. Agents then have to reconstruct the
  // instruction from history alone, which is fragile and sometimes
  // impossible. Prepend the retry context to the original body instead so
  // the fallback model has both the recovery signal AND the task. (#65760)
  const retryMarked = `[Retry after the previous model attempt failed or timed out]\n\n${params.body}`;
  return prelude ? `${prelude}\n\n${retryMarked}` : retryMarked;
}

const CLAUDE_CLI_FALLBACK_PRELUDE_DEFAULT_CHAR_BUDGET = 8_000;
const CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS = 64;

type FallbackTurnLikeMessage = Record<string, unknown>;

function extractFallbackTurnText(message: FallbackTurnLikeMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }
    // Tool calls: render as a compact "(tool: name)" hint so the fallback
    // model sees the conversation flow without the full tool argument blob,
    // which is rarely useful out of context and chews through char budget.
    if (rec.type === "tool_use" && typeof rec.name === "string") {
      parts.push(`(tool call: ${rec.name})`);
      continue;
    }
    if (rec.type === "tool_result") {
      const inner = typeof rec.content === "string" ? rec.content : undefined;
      if (inner) {
        parts.push(`(tool result: ${inner})`);
      } else {
        parts.push("(tool result)");
      }
    }
  }
  return parts.join("\n").trim();
}

function formatFallbackTurns(
  turns: ReadonlyArray<FallbackTurnLikeMessage>,
  remainingBudget: number,
): { text: string; consumed: number } {
  if (turns.length === 0 || remainingBudget <= 0) {
    return { text: "", consumed: 0 };
  }
  const lines: string[] = [];
  let consumed = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || typeof turn !== "object") {
      continue;
    }
    const role = turn.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractFallbackTurnText(turn);
    if (!text) {
      continue;
    }
    const line = `${role}: ${text}`;
    if (consumed + line.length + 1 > remainingBudget) {
      break;
    }
    lines.push(line);
    consumed += line.length + 1;
  }
  lines.reverse();
  return { text: lines.join("\n"), consumed };
}

/**
 * Format a previously-harvested Claude CLI session into a labeled prelude
 * suitable for prepending to a fallback candidate's prompt. Behavior matches
 * Claude Code's own resume strategy after compaction: prefer the explicit
 * summary, then append the most recent turns up to a char budget.
 *
 * Returns an empty string when neither a summary nor any usable turn fits in
 * the budget; callers can treat that as "no context to seed".
 */
export function formatClaudeCliFallbackPrelude(
  seed: ClaudeCliFallbackSeed,
  options?: { charBudget?: number },
): string {
  const charBudget = Math.max(
    CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS,
    options?.charBudget ?? CLAUDE_CLI_FALLBACK_PRELUDE_DEFAULT_CHAR_BUDGET,
  );
  const heading = "## Prior session context (from claude-cli)";
  const sections: string[] = [heading];
  let remaining = charBudget - heading.length;
  if (seed.summaryText) {
    const summarySection = `\nSummary of earlier conversation:\n${seed.summaryText}`;
    if (summarySection.length <= remaining) {
      sections.push(summarySection);
      remaining -= summarySection.length;
    } else {
      // Truncate the summary at a word boundary if it's huge; clearly mark
      // the truncation so the fallback model treats the prelude as a hint,
      // not exhaustive state.
      const slice = seed.summaryText.slice(0, Math.max(0, remaining - 64));
      const lastBreak = slice.lastIndexOf(" ");
      const trimmed = lastBreak > 0 ? slice.slice(0, lastBreak).trimEnd() : slice.trimEnd();
      sections.push(`\nSummary of earlier conversation (truncated):\n${trimmed} …`);
      remaining = 0;
    }
  }
  if (remaining > CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS && seed.recentTurns.length > 0) {
    const { text } = formatFallbackTurns(
      seed.recentTurns as ReadonlyArray<FallbackTurnLikeMessage>,
      remaining - 32,
    );
    if (text) {
      sections.push(`\nRecent turns:\n${text}`);
    }
  }
  // No summary AND no fittable turns => nothing to seed beyond the heading,
  // which would just confuse the model. Drop the prelude entirely.
  if (sections.length === 1) {
    return "";
  }
  return sections.join("\n");
}

/**
 * Read the Claude CLI session pointed to by `cliSessionId` and format a
 * fallback prelude. Returns `""` when no session file is found or when the
 * harvested seed has no usable content.
 */
export function buildClaudeCliFallbackContextPrelude(params: {
  cliSessionId: string | undefined;
  homeDir?: string;
  charBudget?: number;
}): string {
  const sessionId = params.cliSessionId?.trim();
  if (!sessionId) {
    return "";
  }
  const seed = readClaudeCliFallbackSeed({ cliSessionId: sessionId, homeDir: params.homeDir });
  if (!seed) {
    return "";
  }
  return formatClaudeCliFallbackPrelude(seed, { charBudget: params.charBudget });
}

export function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  let rawVisibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { rawText: string; delta: string } => {
    if (!base) {
      return { rawText: chunk, delta: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { rawText: chunk, delta };
    }
    return {
      rawText: `${base}${chunk}`,
      delta: chunk,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (startsWithSilentToken(trimmedLeadCandidate, SILENT_REPLY_TOKEN)) {
          const stripped = stripLeadingSilentToken(leadCandidate, SILENT_REPLY_TOKEN);
          if (stripped) {
            pendingSilentPrefix = "";
            rawVisibleText = leadCandidate;
            visibleText = stripped;
            return { text: stripped, delta: stripped };
          }
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          rawVisibleText = leadCandidate;
          visibleText = leadCandidate;
          return {
            text: visibleText,
            delta: leadCandidate,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(rawVisibleText, chunk);
      rawVisibleText = nextVisible.rawText;
      if (!nextVisible.delta) {
        return null;
      }
      visibleText = `${visibleText}${nextVisible.delta}`;
      return { text: visibleText, delta: nextVisible.delta };
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}
