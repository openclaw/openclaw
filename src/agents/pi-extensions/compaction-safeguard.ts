import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
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
import { collectTextContentBlocks } from "../content-blocks.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
const FALLBACK_SUMMARY =
  "Summary unavailable due to context limits. Older messages were truncated.";
const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request," +
  " early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const MAX_EXTRACTED_IDENTIFIERS = 12;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

function clampNonNegativeInt(value: unknown, fallback: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(normalized));
}

function resolveRecentTurnsPreserve(value: unknown): number {
  return Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE),
  );
}

function resolveQualityGuardMaxRetries(value: unknown): number {
  return Math.min(
    MAX_QUALITY_GUARD_MAX_RETRIES,
    clampNonNegativeInt(value, DEFAULT_QUALITY_GUARD_MAX_RETRIES),
  );
}

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
  return collectTextContentBlocks(content).join("\n");
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

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }
  return parts.join("\n").trim();
}

function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    clampNonNegativeInt(params.recentTurnsPreserve, 0),
  );
  if (preserveTurns <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const preserveMessages = preserveTurns * 2;
  const candidateIndexes: number[] = [];
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const role = (params.messages[i] as { role?: unknown }).role;
    if (role === "user" || role === "assistant") {
      candidateIndexes.push(i);
    }
    if (candidateIndexes.length >= preserveMessages) {
      break;
    }
  }
  if (candidateIndexes.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const preservedIndexSet = new Set(candidateIndexes);
  const summarizableMessages = params.messages.filter((_, idx) => !preservedIndexSet.has(idx));
  const preservedMessages = params.messages
    .filter((_, idx) => preservedIndexSet.has(idx))
    .filter((msg) => {
      const role = (msg as { role?: unknown }).role;
      return role === "user" || role === "assistant";
    });
  return { summarizableMessages, preservedMessages };
}

function formatPreservedTurnsSection(messages: AgentMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  const lines = messages
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      const text = extractMessageText(message);
      if (!text) {
        return null;
      }
      const trimmed =
        text.length > MAX_RECENT_TURN_TEXT_CHARS
          ? `${text.slice(0, MAX_RECENT_TURN_TEXT_CHARS)}...`
          : text;
      return `- ${role}: ${trimmed}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return "";
  }
  return `\n\n## Recent turns preserved verbatim\n${lines.join("\n")}`;
}

function buildCompactionStructureInstructions(customInstructions?: string): string {
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).",
    "Do not omit unresolved asks from the user.",
  ].join("\n");
  const custom = customInstructions?.trim();
  if (!custom) {
    return sectionsTemplate;
  }
  return `${sectionsTemplate}\n\nAdditional focus:\n${custom}`;
}

function sanitizeExtractedIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)\]"'`,;:.!?<>]+$/, "");
}

function extractOpaqueIdentifiers(text: string): string[] {
  const matches =
    text.match(
      /([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w./-]+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g,
    ) ?? [];
  return Array.from(
    new Set(
      matches
        .map((value) => sanitizeExtractedIdentifier(value))
        .filter((value) => value.length >= 4),
    ),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user") {
      continue;
    }
    const text = extractMessageText(msg);
    if (text) {
      return text;
    }
  }
  return null;
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  if (!latestAsk) {
    return true;
  }
  const normalizedSummary = summary.toLowerCase();
  const tokens = latestAsk
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 5)
    .slice(0, 8);
  if (tokens.length === 0) {
    return true;
  }
  return tokens.some((token) => normalizedSummary.includes(token));
}

function auditSummaryQuality(params: {
  summary: string;
  identifiers: string[];
  latestAsk: string | null;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!params.summary.includes(section)) {
      reasons.push(`missing_section:${section}`);
    }
  }
  const missingIdentifiers = params.identifiers.filter((id) => !params.summary.includes(id));
  if (missingIdentifiers.length > 0) {
    reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
  }
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Read and format critical workspace context for compaction summary.
 * Extracts "Session Startup" and "Red Lines" from AGENTS.md.
 * Limited to 2000 chars to avoid bloating the summary.
 */
async function readWorkspaceContextForSummary(): Promise<string> {
  const MAX_SUMMARY_CONTEXT_CHARS = 2000;
  const workspaceDir = process.cwd();
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    if (!fs.existsSync(agentsPath)) {
      return "";
    }

    const content = await fs.promises.readFile(agentsPath, "utf-8");
    const sections = extractSections(content, ["Session Startup", "Red Lines"]);

    if (sections.length === 0) {
      return "";
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_SUMMARY_CONTEXT_CHARS
        ? combined.slice(0, MAX_SUMMARY_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    return `\n\n<workspace-critical-rules>\n${safeContent}\n</workspace-critical-rules>`;
  } catch {
    return "";
  }
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
      const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
      const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? true;
      const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);

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

      const {
        summarizableMessages: summaryTargetMessages,
        preservedMessages: preservedRecentMessages,
      } = splitPreservedRecentTurns({
        messages: messagesToSummarize,
        recentTurnsPreserve,
      });
      messagesToSummarize = summaryTargetMessages;
      const preservedTurnsSection = formatPreservedTurnsSection(preservedRecentMessages);
      const latestUserAsk = extractLatestUserAsk([
        ...messagesToSummarize,
        ...preservedRecentMessages,
        ...turnPrefixMessages,
      ]);
      const identifierSeedText = [...messagesToSummarize, ...preservedRecentMessages]
        .slice(-10)
        .map((message) => extractMessageText(message))
        .filter(Boolean)
        .join("\n");
      const identifiers = extractOpaqueIdentifiers(identifierSeedText);
      const structuredInstructions = buildCompactionStructureInstructions(customInstructions);

      // Use adaptive chunk ratio based on message sizes
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const adaptiveRatio = computeAdaptiveChunkRatio(allMessages, contextWindowTokens);
      const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio));
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

      // Feed dropped-messages summary as previousSummary so the main summarization
      // incorporates context from pruned messages instead of losing it entirely.
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      let summary = "";
      let currentInstructions = structuredInstructions;
      const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        const historySummary = await summarizeInStages({
          messages: messagesToSummarize,
          model,
          apiKey,
          signal,
          reserveTokens,
          maxChunkTokens,
          contextWindow: contextWindowTokens,
          customInstructions: currentInstructions,
          previousSummary: effectivePreviousSummary,
        });

        summary = historySummary;
        if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
          const prefixSummary = await summarizeInStages({
            messages: turnPrefixMessages,
            model,
            apiKey,
            signal,
            reserveTokens,
            maxChunkTokens,
            contextWindow: contextWindowTokens,
            customInstructions: `${TURN_PREFIX_INSTRUCTIONS}\n\n${currentInstructions}`,
            previousSummary: undefined,
          });
          summary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary}`;
        }
        summary += preservedTurnsSection;
        if (!qualityGuardEnabled) {
          break;
        }
        const quality = auditSummaryQuality({
          summary,
          identifiers,
          latestAsk: latestUserAsk,
        });
        if (quality.ok || attempt >= totalAttempts - 1) {
          break;
        }
        const reasons = quality.reasons.join(", ");
        currentInstructions = `${structuredInstructions}\n\nPrevious summary failed quality checks (${reasons}). Fix all issues and include every required section with exact identifiers preserved.`;
      }

      summary += toolFailureSection;
      summary += fileOpsSummary;

      // Append workspace critical context (Session Startup + Red Lines from AGENTS.md)
      const workspaceContext = await readWorkspaceContextForSummary();
      if (workspaceContext) {
        summary += workspaceContext;
      }

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
  splitPreservedRecentTurns,
  formatPreservedTurnsSection,
  buildCompactionStructureInstructions,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
} as const;
