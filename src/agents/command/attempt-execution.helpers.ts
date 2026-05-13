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
import { cliBackendLog } from "../cli-runner/log.js";

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

type JsonlFileScan = { fileExists: boolean; hasAssistant: boolean };

async function scanJsonlFile(filePath: string | undefined): Promise<JsonlFileScan> {
  if (!filePath) {
    return { fileExists: false, hasAssistant: false };
  }
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { fileExists: false, hasAssistant: false };
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
          return { fileExists: true, hasAssistant: true };
        }
      }
      return { fileExists: true, hasAssistant: false };
    } finally {
      await fh.close();
    }
  } catch {
    return { fileExists: false, hasAssistant: false };
  }
}

async function jsonlFileHasAssistantMessage(filePath: string | undefined): Promise<boolean> {
  return (await scanJsonlFile(filePath)).hasAssistant;
}

/**
 * Check whether a session transcript file exists and contains at least one
 * assistant message, indicating that the SessionManager has flushed the
 * initial user+assistant exchange to disk.
 */
export async function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean> {
  return await jsonlFileHasAssistantMessage(sessionFile);
}

/**
 * Compute the on-disk JSONL path claude-cli uses for a given session. The CLI
 * is now invoked with an orchestrator-minted `--session-id <uuid>` and `cwd
 * <workspaceDir>`, which together determine the path:
 *
 *   `<homeDir>/.claude/projects/<encoded(workspaceDir)>/<sessionId>.jsonl`
 *
 * The encoding rule was verified live: claude-cli replaces every non-
 * alphanumeric character in the absolute cwd with a hyphen (so
 * `/home/faris/.openclaw/workspace` becomes `-home-faris--openclaw-workspace`
 * and `/tmp/foo_bar.baz` becomes `-tmp-foo-bar-baz`). The rule is documented
 * by behavior alone, so we keep the encoding regexp localized to this helper
 * — if upstream Claude Code ever changes it, the probe stops finding the file
 * and v4 fails loud (see `claudeCliSessionTranscriptHasContent` below).
 *
 * Returns `null` when the session id is malformed or the workspace is empty.
 */
export function claudeCliSessionTranscriptPath(params: {
  sessionId: string | undefined;
  workspaceDir: string | undefined;
  homeDir?: string;
}): string | null {
  const sessionId = normalizeClaudeCliSessionId(params.sessionId);
  if (!sessionId) {
    return null;
  }
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return null;
  }
  const homeDir = params.homeDir?.trim() || process.env.HOME || os.homedir();
  const encodedWorkspace = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(homeDir, CLAUDE_PROJECTS_RELATIVE_DIR, encodedWorkspace, `${sessionId}.jsonl`);
}

/**
 * Single grace window between the first and second probe of the on-disk
 * claude-cli transcript. v3 used a 0/250/500/1000/1500ms back-off ladder
 * (3250ms total) and still raced the JSONL flush — at 12:37:58 EDT 2026-05-13
 * a live user turn hit `transcript probe negative after 3250ms (no matching
 * jsonl)`, immediately followed by `cli session reset reason=missing-
 * transcript`. v4 abandons the ladder-widening dead-end: the orchestrator now
 * mints the session id (`--session-id <uuid>`), so the JSONL path is fully
 * determined by data we own. A miss past one short grace window is no longer
 * "we lost the race for picking the path" but "the file genuinely isn't
 * there", and we want that to fail loud instead of silently widening forever.
 */
const CLAUDE_CLI_TRANSCRIPT_FLUSH_GRACE_MS = 250;

export async function claudeCliSessionTranscriptHasContent(params: {
  sessionId: string | undefined;
  workspaceDir: string | undefined;
  homeDir?: string;
}): Promise<boolean> {
  const expectedPath = claudeCliSessionTranscriptPath({
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    homeDir: params.homeDir,
  });
  if (!expectedPath) {
    return false;
  }
  const first = await scanJsonlFile(expectedPath);
  if (first.hasAssistant) {
    return true;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, CLAUDE_CLI_TRANSCRIPT_FLUSH_GRACE_MS);
  });
  const second = await scanJsonlFile(expectedPath);
  if (second.hasAssistant) {
    return true;
  }
  // Loud, structured warn — distinct prefix from v1/v2/v3 so log readers can
  // tell which strategy is live. Missing the orchestrator-owned path after a
  // grace window means either the prior turn's claude-cli never flushed (real
  // crash/FS-failure) or the cwd-encoding rule shifted upstream; both are
  // worth investigating individually instead of being papered over by a wider
  // back-off ladder.
  const sessionId = normalizeClaudeCliSessionId(params.sessionId);
  cliBackendLog.warn(
    `claude-cli transcript probe v4 miss (sessionId-deterministic path, grace ${CLAUDE_CLI_TRANSCRIPT_FLUSH_GRACE_MS}ms): sessionId=${sessionId ?? ""} expectedPath=${expectedPath} fileExists=${second.fileExists}`,
  );
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
