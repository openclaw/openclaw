/**
 * Helper functions for agent attempt execution, Claude CLI transcript probing,
 * fallback prompts, and ACP visible-text accumulation.
 */
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../../auto-reply/tokens.js";
import {
  isToolCallBlock,
  resolveToolUseId,
  type ToolContentBlock,
} from "../../chat/tool-content.js";
import {
  readSessionTranscriptBoundedMessageTailPage,
  type SessionTranscriptRuntimeTarget,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import {
  type ClaudeCliFallbackSeed,
  readClaudeCliFallbackSeed,
} from "../../gateway/cli-session-history.js";
import { buildAgentRunTerminalReplySnapshot } from "../agent-run-terminal-reply.js";
import type { AgentRunTerminalReplySnapshot } from "../agent-run-terminal-reply.types.js";
import { cliBackendLog } from "../cli-runner/log.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";

const CLAUDE_CLI_TRANSCRIPT_MAX_RECORDS = 500;

function normalizeClaudeCliSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("/") || trimmed.includes("\\")) {
    return undefined;
  }
  return trimmed;
}

type JsonlFileScan = { fileExists: boolean; hasAssistant: boolean };

async function readCliTranscriptFile<T>(
  filePath: string,
  missing: T,
  read: (file: FileHandle, size: number) => Promise<T>,
): Promise<T> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return missing;
    }
    const file = await fs.open(filePath, "r");
    try {
      return await read(file, stat.size);
    } finally {
      await file.close();
    }
  } catch {
    return missing;
  }
}

async function scanJsonlFile(filePath: string): Promise<JsonlFileScan> {
  return await readCliTranscriptFile<JsonlFileScan>(
    filePath,
    { fileExists: false, hasAssistant: false },
    async (fh) => {
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf-8" }) });
      let recordCount = 0;
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        recordCount++;
        if (recordCount > CLAUDE_CLI_TRANSCRIPT_MAX_RECORDS) {
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
    },
  );
}

/** Checks whether the active SQLite history contains a persisted assistant turn. */
export async function sessionTranscriptHasContent(
  target: SessionTranscriptRuntimeTarget | undefined,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!target) {
    return false;
  }
  await waitForSessionTranscriptProjection(target, abortSignal);
  const { events } = readSessionTranscriptBoundedMessageTailPage(target, {
    maxBytes: 5 * 1024 * 1024,
    maxMessages: 500,
    offset: 0,
  });
  return events.some(
    ({ event }) =>
      isRecord(event) &&
      event.type === "message" &&
      isRecord(event.message) &&
      event.message.role === "assistant",
  );
}

/** Resolves the expected Claude CLI transcript JSONL path for a session. */
function claudeCliSessionTranscriptPath(params: {
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
  return path.join(
    resolveClaudeCliProjectDirForWorkspace({
      workspaceDir,
      homeDir: params.homeDir,
    }),
    `${sessionId}.jsonl`,
  );
}

const CLAUDE_CLI_TRANSCRIPT_FLUSH_GRACE_MS = 250;
const CLAUDE_CLI_ORPHAN_PROBE_TAIL_BYTES = 1024 * 1024;

/** Checks whether Claude CLI has flushed assistant content for a session. */
export async function claudeCliSessionTranscriptHasContent(
  params: Parameters<typeof claudeCliSessionTranscriptPath>[0],
): Promise<boolean> {
  const expectedPath = claudeCliSessionTranscriptPath(params);
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
  const sessionId = normalizeClaudeCliSessionId(params.sessionId);
  cliBackendLog.warn(
    `claude-cli transcript probe v4 miss (sessionId-deterministic path, grace ${CLAUDE_CLI_TRANSCRIPT_FLUSH_GRACE_MS}ms): sessionId=${sessionId ?? ""} expectedPath=${expectedPath} fileExists=${second.fileExists}`,
  );
  return false;
}

function toToolContentBlocks(content: unknown): ToolContentBlock[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.filter((item): item is ToolContentBlock =>
    Boolean(item && typeof item === "object"),
  );
}

function isClaudeTranscriptToolUseBlock(block: ToolContentBlock): boolean {
  const type = block.type;
  return type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use";
}

function isClaudeTranscriptToolResultBlock(block: ToolContentBlock): boolean {
  const type = block.type;
  return type === "tool_result" || (typeof type === "string" && type.endsWith("_tool_result"));
}

async function jsonlFileHasOrphanedTrailingToolUse(filePath: string): Promise<boolean> {
  return await readCliTranscriptFile(filePath, false, async (fh, size) => {
    const tailBytes = Math.min(size, CLAUDE_CLI_ORPHAN_PROBE_TAIL_BYTES);
    const start = size - tailBytes;
    const buffer = Buffer.alloc(tailBytes);
    const { bytesRead } = await fh.read(buffer, 0, tailBytes, start);
    let tailText = buffer.toString("utf-8", 0, bytesRead);
    if (start > 0) {
      const firstNewline = tailText.indexOf("\n");
      tailText = firstNewline === -1 ? "" : tailText.slice(firstNewline + 1);
    }
    let lastAssistantToolUseIds: Set<string> = new Set();
    let answeredToolResultIds: Set<string> = new Set();
    for (const line of tailText.split(/\r?\n/)) {
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
      if (rec?.isSidechain === true) {
        continue;
      }
      const message = rec?.message as Record<string, unknown> | undefined;
      const role = message?.role;
      if (role === "assistant") {
        lastAssistantToolUseIds = new Set();
        answeredToolResultIds = new Set();
      } else if (role !== "user") {
        continue;
      }
      for (const block of toToolContentBlocks(message?.content) ?? []) {
        const target =
          role === "assistant" && isClaudeTranscriptToolUseBlock(block)
            ? lastAssistantToolUseIds
            : isClaudeTranscriptToolResultBlock(block)
              ? answeredToolResultIds
              : undefined;
        if (target) {
          const id = resolveToolUseId(block);
          if (id) {
            target.add(id);
          }
        }
      }
    }
    for (const id of lastAssistantToolUseIds) {
      if (!answeredToolResultIds.has(id)) {
        return true;
      }
    }
    return false;
  });
}

/** Checks whether the latest Claude CLI transcript tail has unanswered tool use. */
export async function claudeCliSessionTranscriptHasOrphanedToolUse(
  params: Parameters<typeof claudeCliSessionTranscriptPath>[0],
): Promise<boolean> {
  const expectedPath = claudeCliSessionTranscriptPath(params);
  if (!expectedPath) {
    return false;
  }
  return await jsonlFileHasOrphanedTrailingToolUse(expectedPath);
}

/** Builds the retry prompt sent to fallback models after a failed attempt. */
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
  // Retain the original task: failed history may not contain enough context to reconstruct it. (#65760)
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
    if (isToolCallBlock(rec) && typeof rec.name === "string") {
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
): string {
  if (turns.length === 0 || remainingBudget <= 0) {
    return "";
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
  return lines.join("\n");
}

/** Prefer the harvested summary, then retain recent turns within the fallback prompt budget. */
function formatClaudeCliFallbackPrelude(
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
      const slice = truncateUtf16Safe(seed.summaryText, Math.max(0, remaining - 64));
      const lastBreak = slice.lastIndexOf(" ");
      const trimmed = lastBreak > 0 ? slice.slice(0, lastBreak).trimEnd() : slice.trimEnd();
      sections.push(`\nSummary of earlier conversation (truncated):\n${trimmed} …`);
      remaining = 0;
    }
  }
  if (remaining > CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS && seed.recentTurns.length > 0) {
    const text = formatFallbackTurns(
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

/** Read a CLI session and project the available fallback context. */
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

/** Creates an accumulator that strips ACP silent-reply prefixes while streaming. */
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
    finalizeReplySnapshot(): AgentRunTerminalReplySnapshot {
      return buildAgentRunTerminalReplySnapshot({
        visibleText,
        rawText: pendingSilentPrefix,
      });
    },
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.attemptExecutionHelpersTestApi")
  ] = { claudeCliSessionTranscriptPath, formatClaudeCliFallbackPrelude };
}
