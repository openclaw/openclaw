import type { OpenVikingClient, OVMessage } from "./client.js";
import type { MemoryOpenVikingConfig } from "./config.js";
import {
  getCaptureDecision,
  extractNewTurnTexts,
} from "./text-utils.js";
import {
  trimForLog,
  toJsonLog,
} from "./memory-ranking.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";


// Simple in-memory lock to prevent concurrent commits
export const commitLocks = new Set<string>();
type AgentMessage = {
  role?: string;
  content?: unknown;
};

type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction: true;
};

type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

type IngestResult = {
  ingested: boolean;
};

type IngestBatchResult = {
  ingestedCount: number;
};

type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: unknown;
};

type ContextEngine = {
  info: ContextEngineInfo;
  ingest: (params: { sessionId: string; message: AgentMessage; isHeartbeat?: boolean }) => Promise<IngestResult>;
  ingestBatch?: (params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }) => Promise<IngestBatchResult>;
  afterTurn?: (params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<void>;
  assemble: (params: { sessionId: string; messages: AgentMessage[]; tokenBudget?: number }) => Promise<AssembleResult>;
  compact: (params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<CompactResult>;
};

export type ContextEngineWithCommit = ContextEngine & {
  /** Commit (archive + extract) the OV session. Returns true on success. */
  commitOVSession: (sessionId: string) => Promise<boolean>;
};

type Logger = {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
  error: (msg: string) => void;
};

function estimateTokens(messages: AgentMessage[]): number {
  return Math.max(1, messages.length * 80);
}

function roughEstimate(messages: AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function msgTokenEstimate(msg: AgentMessage): number {
  const raw = (msg as Record<string, unknown>).content;
  if (typeof raw === "string") return Math.ceil(raw.length / 4);
  if (Array.isArray(raw)) return Math.ceil(JSON.stringify(raw).length / 4);
  return 1;
}

function messageDigest(messages: AgentMessage[], maxCharsPerMsg = 2000): Array<{role: string; content: string; tokens: number; truncated: boolean}> {
  return messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const raw = m.content;
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Array.isArray(raw)) {
      text = (raw as Record<string, unknown>[])
        .map((b) => {
          if (b.type === "text") return String(b.text ?? "");
          if (b.type === "toolUse") return `[toolUse: ${String(b.name)}(${JSON.stringify(b.arguments ?? {}).slice(0, 200)})]`;
          if (b.type === "toolResult") return `[toolResult: ${JSON.stringify(b.content ?? "").slice(0, 200)}]`;
          return `[${String(b.type)}]`;
        })
        .join("\n");
    } else {
      text = JSON.stringify(raw) ?? "";
    }
    const truncated = text.length > maxCharsPerMsg;
    return {
      role,
      content: truncated ? text.slice(0, maxCharsPerMsg) + "..." : text,
      tokens: msgTokenEstimate(msg),
      truncated,
    };
  });
}

function emitDiag(log: typeof logger, stage: string, sessionId: string, data: Record<string, unknown>, enabled = true): void {
  if (!enabled) return;
  log.info(`openviking: diag ${JSON.stringify({ ts: Date.now(), stage, sessionId, data })}`);
}

function totalExtractedMemories(memories?: Record<string, number>): number {
  if (!memories || typeof memories !== "object") {
    return 0;
  }
  return Object.values(memories).reduce((sum, count) => sum + (count ?? 0), 0);
}

function validTokenBudget(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return undefined;
}

/**
 * Convert an OpenViking stored message (parts-based format) into one or more
 * OpenClaw AgentMessages (content-blocks format).
 *
 * For assistant messages with ToolParts, this produces:
 * 1. The assistant message with toolUse blocks in its content array
 * 2. A separate toolResult message per ToolPart (carrying tool_output)
 */
function convertToAgentMessages(msg: { role: string; parts: unknown[] }): AgentMessage[] {
  const parts = msg.parts ?? [];
  const contentBlocks: Record<string, unknown>[] = [];
  const toolResults: AgentMessage[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;

    if (p.type === "text" && typeof p.text === "string") {
      contentBlocks.push({ type: "text", text: p.text });
    } else if (p.type === "context") {
      if (typeof p.abstract === "string" && p.abstract) {
        contentBlocks.push({ type: "text", text: p.abstract });
      }
    } else if (p.type === "tool" && msg.role === "assistant") {
      const toolId = typeof p.tool_id === "string" ? p.tool_id : "";
      const toolName = typeof p.tool_name === "string" ? p.tool_name : "unknown";

      if (toolId) {
        contentBlocks.push({
          type: "toolUse",
          id: toolId,
          name: toolName,
          input: p.tool_input ?? {},
        });

        const status = typeof p.tool_status === "string" ? p.tool_status : "";
        const output = typeof p.tool_output === "string" ? p.tool_output : "";

        if (status === "completed" || status === "error") {
          toolResults.push({
            role: "toolResult",
            toolCallId: toolId,
            toolName,
            content: [{ type: "text", text: output || "(no output)" }],
            isError: status === "error",
          } as unknown as AgentMessage);
        } else {
          toolResults.push({
            role: "toolResult",
            toolCallId: toolId,
            toolName,
            content: [{ type: "text", text: "(interrupted — tool did not complete)" }],
            isError: false,
          } as unknown as AgentMessage);
        }
      } else {
        // No tool_id: degrade to text block to preserve information.
        // Cannot emit toolUse/toolResult without a valid id.
        const status = typeof p.tool_status === "string" ? p.tool_status : "unknown";
        const output = typeof p.tool_output === "string" ? p.tool_output : "";
        const segments = [`[${toolName}] (${status})`];
        if (p.tool_input) {
          try {
            segments.push(`Input: ${JSON.stringify(p.tool_input)}`);
          } catch {
            // non-serializable input, skip
          }
        }
        if (output) {
          segments.push(`Output: ${output}`);
        }
        contentBlocks.push({ type: "text", text: segments.join("\n") });
      }
    }
  }

  const result: AgentMessage[] = [];

  if (msg.role === "assistant") {
    result.push({ role: msg.role, content: contentBlocks });
    result.push(...toolResults);
  } else {
    const texts = contentBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text as string);
    result.push({ role: msg.role, content: texts.join("\n") || "" });
  }

  return result;
}

function normalizeAssistantContent(messages: AgentMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === "assistant" && typeof msg.content === "string") {
      messages[i] = {
        ...msg,
        content: [{ type: "text", text: msg.content }],
      };
    }
  }
}

export function formatMessageFaithful(msg: OVMessage): string {
  const roleTag = `[${msg.role}]`;
  if (!msg.parts || msg.parts.length === 0) {
    return `${roleTag}: (empty)`;
  }

  const sections: string[] = [];
  for (const part of msg.parts) {
    if (!part || typeof part !== "object") continue;
    switch (part.type) {
      case "text":
        if (part.text) sections.push(part.text);
        break;
      case "tool": {
        const status = part.tool_status ?? "unknown";
        const header = `[Tool: ${part.tool_name ?? "unknown"}] (${status})`;
        const inputStr = part.tool_input
          ? `Input: ${JSON.stringify(part.tool_input, null, 2)}`
          : "";
        const outputStr = part.tool_output ? `Output:\n${part.tool_output}` : "";
        sections.push([header, inputStr, outputStr].filter(Boolean).join("\n"));
        break;
      }
      case "context":
        sections.push(
          `[Context: ${part.uri ?? "?"}]${part.abstract ? ` ${part.abstract}` : ""}`,
        );
        break;
      default:
        sections.push(`[${part.type}]: ${JSON.stringify(part)}`);
    }
  }

  return `${roleTag}:\n${sections.join("\n\n")}`;
}

function buildSystemPromptAddition(): string {
  return [
    "## Session Context Guide",
    "",
    "Your conversation history may include:",
    "",
    "1. **[Session History Summary]** — A compressed summary of all prior",
    "   conversation sessions. Use it to understand background and continuity.",
    "   It is lossy: specific details (commands, file paths, code, config",
    "   values) may have been compressed away. It may be omitted when the",
    "   token budget is tight.",
    "",
    "2. **[Archive Index]** — A list of archive entries in chronological order",
    "   (archive_001 is the oldest, higher numbers are more recent). Most",
    "   lines summarize one archive; the latest archive may appear as an ID",
    "   pointer only.",
    "",
    "3. **Active messages** — The current, uncompressed conversation.",
    "",
    "**When you need precise details from a prior session:**",
    "",
    "1. Review [Archive Index] to identify which archive likely contains",
    "   the information you need.",
    "2. Call `ov_archive_expand` with that archive ID to retrieve the",
    "   archived conversation content.",
    "3. If multiple archives look relevant, try the most recent one first.",
    "4. Answer using the retrieved content together with active messages.",
    "",
    "**Rules:**",
    "- If active messages conflict with archive content, trust active",
    "  messages as the newer source of truth.",
    "- Only expand an archive when the existing context lacks the specific detail needed.",
    "- If [Session History Summary] is absent, use [Archive Index] and active",
    "  messages to decide whether to expand an archive.",
    "- Do not fabricate details from summaries. When uncertain, expand first",
    "  or state that the information comes from a compressed summary.",
    "- After expanding, cite the archive ID in your answer",
    '  (e.g. "Based on archive_003, ...").',
  ].join("\n");
}

function warnOrInfo(logger: Logger, message: string): void {
  if (typeof logger.warn === "function") {
    logger.warn(message);
    return;
  }
  logger.info(message);
}

function formatMessagesForLog(label: string, messages: AgentMessage[]): string {
  const lines: string[] = [`===== ${label} (${messages.length} msgs) =====`];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    const role = msg.role ?? "?";
    const raw = msg.content;
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Array.isArray(raw)) {
      text = (raw as Record<string, unknown>[])
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "toolUse") return `[toolUse: ${b.name}]`;
          if (b.type === "toolResult") return `[toolResult]`;
          return `[${b.type}]`;
        })
        .join("\n");
    } else {
      text = JSON.stringify(raw, null, 2);
    }
    lines.push(`--- [${i}] ${role} ---`);
    lines.push(String(text));
  }
  lines.push(`===== /${label} =====`);
  return lines.join("\n");
}

export function createMemoryOpenVikingContextEngine(params: {
  id: string;
  name: string;
  version?: string;
  cfg: Required<MemoryOpenVikingConfig>;
  logger: Logger;
  getClient: () => Promise<OpenVikingClient>;
  resolveAgentId: (sessionId: string) => string;
}): ContextEngineWithCommit {
  const {
    id,
    name,
    version,
    cfg,
    logger,
    getClient,
    resolveAgentId,
  } = params;

  const diagEnabled = cfg.emitStandardDiagnostics;
  const diag = (stage: string, sessionId: string, data: Record<string, unknown>) =>
    emitDiag(logger, stage, sessionId, data, diagEnabled);

  async function doCommitOVSession(sessionId: string): Promise<boolean> {
    try {
      const client = await getClient();
      const agentId = resolveAgentId(sessionId);
      const commitResult = await client.commitSession(sessionId, { wait: true, agentId });
      const memCount = totalExtractedMemories(commitResult.memories_extracted);
      if (commitResult.status === "failed") {
        warnOrInfo(logger, `openviking: commit Phase 2 failed for session=${sessionId}: ${commitResult.error ?? "unknown"}`);
        return false;
      }
      if (commitResult.status === "timeout") {
        warnOrInfo(logger, `openviking: commit Phase 2 timed out for session=${sessionId}, task_id=${commitResult.task_id ?? "none"}`);
        return false;
      }
      logger.info(
        `openviking: committed OV session=${sessionId}, archived=${commitResult.archived ?? false}, memories=${memCount}, task_id=${commitResult.task_id ?? "none"}`,
      );
      return true;
    } catch (err) {
      warnOrInfo(logger, `openviking: commit failed for session=${sessionId}: ${String(err)}`);
      return false;
    }
  }

  return {
    info: {
      id,
      name,
      version,
      ownsCompaction: true,
    },

    commitOVSession: doCommitOVSession,

    // --- standard ContextEngine methods ---

    async ingest(): Promise<IngestResult> {
      return { ingested: false };
    },

    async ingestBatch(): Promise<IngestBatchResult> {
      return { ingestedCount: 0 };
    },

    async assemble(assembleParams): Promise<AssembleResult> {
      const { messages } = assembleParams;
      const tokenBudget = validTokenBudget(assembleParams.tokenBudget) ?? 128_000;

      const originalTokens = roughEstimate(messages);
      logger.info(`openviking: assemble input msgs=${messages.length} ~${originalTokens} tokens, budget=${validTokenBudget(assembleParams.tokenBudget) ?? 128_000}`);
      
      const OVSessionId = assembleParams.sessionId;
      diag("assemble_entry", OVSessionId, {
        messagesCount: messages.length,
        inputTokenEstimate: originalTokens,
        tokenBudget,
        messages: messageDigest(messages),
      });

      try {
        const client = await getClient();
        const agentId = resolveAgentId(OVSessionId);
        const ctx = await client.getSessionContext(
          OVSessionId,
          tokenBudget,
          agentId,
        );

        const hasArchives = !!ctx?.latest_archive_id;
        const activeCount = ctx?.messages?.length ?? 0;
        const preAbstracts = ctx?.pre_archive_abstracts ?? [];
        logger.info(
          `openviking: assemble OV ctx hasArchives=${hasArchives} latestId=${ctx?.latest_archive_id ?? "none"} preAbstracts=${preAbstracts.length} active=${activeCount}`,
        );

        if (!ctx || (!hasArchives && activeCount === 0)) {
          logger.info("openviking: assemble passthrough (no OV data)");
          diag("assemble_result", OVSessionId, {
            passthrough: true, reason: "no_ov_data",
            archiveCount: 0, activeCount: 0,
            outputMessagesCount: messages.length,
            inputTokenEstimate: originalTokens,
            estimatedTokens: originalTokens,
            tokensSaved: 0, savingPct: 0,
          });
          return { messages, estimatedTokens: roughEstimate(messages) };
        }

        if (!hasArchives && ctx.messages.length < messages.length) {
          logger.info(`openviking: assemble passthrough (OV msgs=${ctx.messages.length} < input msgs=${messages.length})`);
          diag("assemble_result", OVSessionId, {
            passthrough: true, reason: "ov_msgs_fewer_than_input",
            archiveCount: 0, activeCount,
            outputMessagesCount: messages.length,
            inputTokenEstimate: originalTokens,
            estimatedTokens: originalTokens,
            tokensSaved: 0, savingPct: 0,
          });
          return { messages, estimatedTokens: roughEstimate(messages) };
        }

        const assembled: AgentMessage[] = [];

        if (ctx.latest_archive_overview) {
          assembled.push({
            role: "user" as const,
            content: `[Session History Summary]\n${ctx.latest_archive_overview}`,
          });
        }

        if (preAbstracts.length > 0 || ctx.latest_archive_id) {
          const lines: string[] = preAbstracts.map(
            (a) => `${a.archive_id}: ${a.abstract}`,
          );
          if (ctx.latest_archive_id) {
            lines.push(
              `(latest: ${ctx.latest_archive_id} — see [Session History Summary] above)`,
            );
          }
          assembled.push({
            role: "user" as const,
            content: `[Archive Index]\n${lines.join("\n")}`,
          });
        }

        assembled.push(...ctx.messages.flatMap((m) => convertToAgentMessages(m)));

        normalizeAssistantContent(assembled);
        const sanitized = sanitizeToolUseResultPairing(assembled as never[]) as AgentMessage[];

        if (sanitized.length === 0 && messages.length > 0) {
          logger.info("openviking: assemble passthrough (sanitized=0, falling back to original)");
          diag("assemble_result", OVSessionId, {
            passthrough: true, reason: "sanitized_empty",
            archiveCount: preAbstracts.length + (ctx.latest_archive_id ? 1 : 0),
            activeCount,
            outputMessagesCount: messages.length,
            inputTokenEstimate: originalTokens,
            estimatedTokens: originalTokens,
            tokensSaved: 0, savingPct: 0,
          });
          return { messages, estimatedTokens: roughEstimate(messages) };
        }

        const assembledTokens = roughEstimate(sanitized);
        const archiveCount = preAbstracts.length + (ctx.latest_archive_id ? 1 : 0);
        logger.info(`openviking: assemble result msgs=${sanitized.length} ~${assembledTokens} tokens (ovEstimate=${ctx.estimatedTokens}), archives=${archiveCount}, active=${activeCount}`);
        const tokensSaved = originalTokens - assembledTokens;
        const savingPct = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;

        diag("assemble_result", OVSessionId, {
          passthrough: false,
          archiveCount,
          activeCount,
          outputMessagesCount: sanitized.length,
          inputTokenEstimate: originalTokens,
          estimatedTokens: assembledTokens,
          tokensSaved,
          savingPct,
          latestArchiveId: ctx.latest_archive_id ?? null,
          messages: messageDigest(sanitized),
        });

        return {
          messages: sanitized,
          estimatedTokens: ctx.estimatedTokens,
          ...(hasArchives
            ? { systemPromptAddition: buildSystemPromptAddition() }
            : {}),
        };
      } catch (err) {
        diag("assemble_error", OVSessionId, {
          error: String(err),
        });
        return { messages, estimatedTokens: roughEstimate(messages) };
      }
    },

    async afterTurn(afterTurnParams): Promise<void> {
      if (!cfg.autoCapture) {
        return;
      }

      const OVSessionId = afterTurnParams.sessionId;
      
      // Lock check to prevent CONFLICT
      if (commitLocks.has(OVSessionId)) {
        logger.info(`openviking: afterTurn skipped (commit in progress for ${OVSessionId})`);
        return;
      }
      commitLocks.add(OVSessionId);

      try {
        const agentId = resolveAgentId(OVSessionId);

        const messages = afterTurnParams.messages ?? [];
        if (messages.length === 0) {
          logger.info("openviking: afterTurn skipped (messages=0)");
          diag("afterTurn_skip", OVSessionId, {
            reason: "no_messages",
            totalMessages: 0,
          });
          return;
        }

        const start =
          typeof afterTurnParams.prePromptMessageCount === "number" &&
          afterTurnParams.prePromptMessageCount >= 0
            ? afterTurnParams.prePromptMessageCount
            : 0;

        const { texts: newTexts, newCount } = extractNewTurnTexts(messages, start);

        if (newTexts.length === 0) {
          logger.info("openviking: afterTurn skipped (no new user/assistant messages)");
          diag("afterTurn_skip", OVSessionId, {
            reason: "no_new_turn_messages",
            totalMessages: messages.length,
            prePromptMessageCount: start,
          });
          return;
        }

        const newMessages = messages.slice(start).filter((m: any) => {
          const r = (m as Record<string, unknown>).role as string;
          return r === "user" || r === "assistant";
        }) as AgentMessage[];
        const newMsgFull = messageDigest(newMessages);
        const newTurnTokens = newMsgFull.reduce((s, d) => s + d.tokens, 0);

        diag("afterTurn_entry", OVSessionId, {
          totalMessages: messages.length,
          newMessageCount: newCount,
          prePromptMessageCount: start,
          newTurnTokens,
          messages: newMsgFull,
        });

        const client = await getClient();
        const turnText = newTexts.join("\n");
        const sanitized = turnText.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, " ").replace(/\s+/g, " ").trim();

        if (sanitized) {
          await client.addSessionMessage(OVSessionId, "user", sanitized, agentId);
          logger.info(
            `openviking: afterTurn stored ${newCount} msgs in session=${OVSessionId} (${sanitized.length} chars)`,
          );
        } else {
          logger.info("openviking: afterTurn skipped store (sanitized text empty)");
          diag("afterTurn_skip", OVSessionId, {
            reason: "sanitized_empty",
          });
          return;
        }

        const session = await client.getSession(OVSessionId, agentId);
        const pendingTokens = session.pending_tokens ?? 0;

        if (pendingTokens < cfg.commitTokenThreshold) {
          logger.info(
            `openviking: pending_tokens=${pendingTokens}/${cfg.commitTokenThreshold} in session=${OVSessionId}, deferring commit`,
          );
          diag("afterTurn_skip", OVSessionId, {
            reason: "below_threshold",
            pendingTokens,
            commitTokenThreshold: cfg.commitTokenThreshold,
          });
          return;
        }

        logger.info(
          `openviking: committing session=${OVSessionId} (wait=false), pendingTokens=${pendingTokens}, threshold=${cfg.commitTokenThreshold}`,
        );
        const commitResult = await client.commitSession(OVSessionId, { wait: false, agentId });
        logger.info(
          `openviking: committed session=${OVSessionId}, ` +
            `status=${commitResult.status}, archived=${commitResult.archived ?? false}, ` +
            `task_id=${commitResult.task_id ?? "none"} ${toJsonLog({ captured: [trimForLog(turnText, 260)] })}`,
        );

        diag("afterTurn_commit", OVSessionId, {
          pendingTokens,
          commitTokenThreshold: cfg.commitTokenThreshold,
          status: commitResult.status,
          archived: commitResult.archived ?? false,
          taskId: commitResult.task_id ?? null,
          extractedMemories: (commitResult as any).extracted_memories ?? null,
        });
      } catch (err) {
        warnOrInfo(logger, `openviking: afterTurn failed: ${String(err)}`);
        diag("afterTurn_error", OVSessionId, {
          error: String(err),
        });
      } finally {
        commitLocks.delete(OVSessionId);
      }
    },

    async compact(compactParams): Promise<CompactResult> {
      const OVSessionId = compactParams.sessionId;
      diag("compact_entry", OVSessionId, {
        tokenBudget: compactParams.tokenBudget ?? null,
        force: compactParams.force ?? false,
        currentTokenCount: compactParams.currentTokenCount ?? null,
        compactionTarget: compactParams.compactionTarget ?? null,
        hasCustomInstructions: typeof compactParams.customInstructions === "string" &&
          compactParams.customInstructions.trim().length > 0,
      });

      try {
        const client = await getClient();
        const agentId = resolveAgentId(OVSessionId);
        logger.info(
          `openviking: compact committing session=${OVSessionId} (wait=true)`,
        );
        const commitResult = await client.commitSession(OVSessionId, { wait: true, agentId });
        const memCount = totalExtractedMemories(commitResult.memories_extracted);

        if (commitResult.status === "failed") {
          warnOrInfo(
            logger,
            `openviking: compact commit Phase 2 failed for session=${OVSessionId}: ${commitResult.error ?? "unknown"}`,
          );
          diag("compact_result", OVSessionId, {
            ok: false,
            compacted: false,
            reason: "commit_failed",
            status: commitResult.status,
            archived: commitResult.archived ?? false,
            taskId: commitResult.task_id ?? null,
            error: commitResult.error ?? null,
          });
          return {
            ok: false,
            compacted: false,
            reason: "commit_failed",
            result: commitResult,
          };
        }

        if (commitResult.status === "timeout") {
          warnOrInfo(
            logger,
            `openviking: compact commit Phase 2 timed out for session=${OVSessionId}, task_id=${commitResult.task_id ?? "none"}`,
          );
          diag("compact_result", OVSessionId, {
            ok: false,
            compacted: false,
            reason: "commit_timeout",
            status: commitResult.status,
            archived: commitResult.archived ?? false,
            taskId: commitResult.task_id ?? null,
          });
          return {
            ok: false,
            compacted: false,
            reason: "commit_timeout",
            result: commitResult,
          };
        }

        logger.info(
          `openviking: compact committed session=${OVSessionId}, archived=${commitResult.archived ?? false}, memories=${memCount}, task_id=${commitResult.task_id ?? "none"}`,
        );

        if (!commitResult.archived) {
          diag("compact_result", OVSessionId, {
            ok: true,
            compacted: false,
            reason: "commit_no_archive",
            status: commitResult.status,
            archived: commitResult.archived ?? false,
            taskId: commitResult.task_id ?? null,
            memories: memCount,
          });
          return {
            ok: true,
            compacted: false,
            reason: "commit_no_archive",
            result: commitResult,
          };
        }

        diag("compact_result", OVSessionId, {
          ok: true,
          compacted: true,
          reason: "commit_completed",
          status: commitResult.status,
          archived: commitResult.archived ?? false,
          taskId: commitResult.task_id ?? null,
          memories: memCount,
        });
        return {
          ok: true,
          compacted: true,
          reason: "commit_completed",
          result: commitResult,
        };
      } catch (err) {
        warnOrInfo(logger, `openviking: compact commit failed for session=${OVSessionId}: ${String(err)}`);
        diag("compact_error", OVSessionId, {
          error: String(err),
        });
        return {
          ok: false,
          compacted: false,
          reason: "commit_error",
          result: {
            error: String(err),
          },
        };
      }
    },
  };
}
