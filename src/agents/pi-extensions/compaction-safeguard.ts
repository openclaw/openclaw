import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
const FALLBACK_SUMMARY =
  "Summary unavailable due to context limits. Older messages were truncated.";
const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request," +
  " early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
export const MAX_LAST_TURN_TOKENS = 4000;
const MAX_TOOL_FAILURE_CHARS = 240;

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

function normalizeFailureText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateFailureText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? record.exitCode
      : undefined;
  const parts: string[] = [];
  if (status) {
    parts.push(`status=${status}`);
  }
  if (exitCode !== undefined) {
    parts.push(`exitCode=${exitCode}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  return parts.join("\n");
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "toolResult") {
      continue;
    }
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (toolResult.isError !== true) {
      continue;
    }
    const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) {
      continue;
    }
    seen.add(toolCallId);

    const toolName =
      typeof toolResult.toolName === "string" && toolResult.toolName.trim()
        ? toolResult.toolName
        : "tool";
    const rawText = extractToolResultText(toolResult.content);
    const meta = formatToolFailureMeta(toolResult.details);
    const normalized = normalizeFailureText(rawText);
    const summary = truncateFailureText(
      normalized || (meta ? "failed" : "failed (no output)"),
      MAX_TOOL_FAILURE_CHARS,
    );
    failures.push({ toolCallId, toolName, summary, meta });
  }

  return failures;
}

function formatToolFailuresSection(failures: ToolFailure[]): string {
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Extract the last conversation turn from messages.
 * A "turn" starts at the last user message and includes everything after it
 * (assistant responses, tool calls, tool results).
 * If no user message is found, returns the last assistant message (if any).
 */
export function extractLastTurn(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) {
    return [];
  }

  // Walk backwards to find the last user message
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && (msg as { role?: unknown }).role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex >= 0) {
    // Return everything from the last user message to the end
    return messages.slice(lastUserIndex);
  }

  // No user message found — return the last assistant message if present
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && (msg as { role?: unknown }).role === "assistant") {
      return [msg];
    }
  }

  return [];
}

/**
 * Serialize a set of messages (typically the last turn) into human-readable text.
 * Truncates if the estimated token count exceeds maxTokens.
 *
 * Uses the same serialization format as the upstream compaction serializer:
 *   [User]: ..., [Assistant]: ..., [Tool result]: ...
 */
export function serializeLastTurn(messages: AgentMessage[], maxTokens: number): string {
  if (messages.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (role === "user") {
      const content = (msg as { content?: unknown }).content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content as Array<{ type?: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("")
            : "";
      if (text) {
        parts.push(`[User]: ${text}`);
      }
    } else if (role === "assistant") {
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const block of content as Array<{
          type?: string;
          text?: string;
          name?: string;
          arguments?: Record<string, unknown>;
        }>) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "toolCall" && block.name) {
            const args = block.arguments ?? {};
            const argsStr = Object.entries(args)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
            toolCalls.push(`${block.name}(${argsStr})`);
          }
        }
        if (textParts.length > 0) {
          parts.push(`[Assistant]: ${textParts.join("\n")}`);
        }
        if (toolCalls.length > 0) {
          parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
        }
      }
    } else if (role === "toolResult") {
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const text = (content as Array<{ type?: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        if (text) {
          parts.push(`[Tool result]: ${text}`);
        }
      }
    }
  }

  if (parts.length === 0) {
    return "";
  }

  let serialized = parts.join("\n\n");

  // Estimate tokens and truncate if needed
  // estimateTokens uses chars/4 heuristic, so maxTokens * 4 ≈ max chars
  const maxChars = maxTokens * 4;
  if (serialized.length > maxChars) {
    const truncated = serialized.slice(0, Math.max(0, maxChars - 20));
    serialized = truncated + "\n\n[truncated]";
  }

  return serialized;
}

export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailures = collectToolFailures([
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]);
    const toolFailureSection = formatToolFailuresSection(toolFailures);
    const fallbackSummary = `${FALLBACK_SUMMARY}${toolFailureSection}${fileOpsSummary}`;

    const model = ctx.model;
    if (!model) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    try {
      const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      let messagesToSummarize = preparation.messagesToSummarize;

      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        // Apply SAFETY_MARGIN so token underestimates don't trigger unnecessary pruning
        const maxHistoryTokens = Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN);

        if (newContentTokens > maxHistoryTokens) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToSummarize,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
          if (pruned.droppedChunks > 0) {
            const newContentRatio = (newContentTokens / contextWindowTokens) * 100;
            console.warn(
              `Compaction safeguard: new content uses ${newContentRatio.toFixed(
                1,
              )}% of context; dropped ${pruned.droppedChunks} older chunk(s) ` +
                `(${pruned.droppedMessages} messages) to fit history budget.`,
            );
            messagesToSummarize = pruned.messages;

            // Summarize dropped messages so context isn't lost
            if (pruned.droppedMessagesList.length > 0) {
              try {
                const droppedChunkRatio = computeAdaptiveChunkRatio(
                  pruned.droppedMessagesList,
                  contextWindowTokens,
                );
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio),
                );
                droppedSummary = await summarizeInStages({
                  messages: pruned.droppedMessagesList,
                  model,
                  apiKey,
                  signal,
                  reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
                  maxChunkTokens: droppedMaxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                console.warn(
                  `Compaction safeguard: failed to summarize dropped messages, continuing without: ${
                    droppedError instanceof Error ? droppedError.message : String(droppedError)
                  }`,
                );
              }
            }
          }
        }
      }

      // Use adaptive chunk ratio based on message sizes
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const adaptiveRatio = computeAdaptiveChunkRatio(allMessages, contextWindowTokens);
      const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio));
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

      // Feed dropped-messages summary as previousSummary so the main summarization
      // incorporates context from pruned messages instead of losing it entirely.
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      const historySummary = await summarizeInStages({
        messages: messagesToSummarize,
        model,
        apiKey,
        signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: contextWindowTokens,
        customInstructions,
        previousSummary: effectivePreviousSummary,
      });

      let summary = historySummary;
      if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
        const prefixSummary = await summarizeInStages({
          messages: turnPrefixMessages,
          model,
          apiKey,
          signal,
          reserveTokens,
          maxChunkTokens,
          contextWindow: contextWindowTokens,
          customInstructions: TURN_PREFIX_INSTRUCTIONS,
          previousSummary: undefined,
        });
        summary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary}`;
      }

      // Inject raw last turn for continuity after compaction.
      // This preserves the exact last exchange so the agent doesn't lose track
      // of where the conversation was when compaction fired.
      const allSummarizedMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const lastTurn = extractLastTurn(allSummarizedMessages);
      if (lastTurn.length > 0) {
        const lastTurnText = serializeLastTurn(lastTurn, MAX_LAST_TURN_TOKENS);
        if (lastTurnText) {
          summary += `\n\n---\n\n<last-turn>\n${lastTurnText}\n</last-turn>`;
        }
      }

      summary += toolFailureSection;
      summary += fileOpsSummary;

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch (error) {
      console.warn(
        `Compaction summarization failed; truncating history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }
  });
}

export const __testing = {
  collectToolFailures,
  formatToolFailuresSection,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  extractLastTurn,
  serializeLastTurn,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  MAX_LAST_TURN_TOKENS,
} as const;
