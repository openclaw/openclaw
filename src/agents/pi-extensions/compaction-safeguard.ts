import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
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
const MAX_TOOL_FAILURE_CHARS = 240;

/**
 * Maximum number of recent messages to preserve images in.
 * Images in older messages will be replaced with text placeholders.
 * This prevents 413 errors from accumulated screenshots bloating the session.
 */
const KEEP_RECENT_IMAGES_COUNT = 3;

// ============================================================================
// Image Stripping Functions (413 Session Bloat Prevention)
// ============================================================================

type ContentBlock = { type?: string; data?: string; mimeType?: string; text?: string };

function isImageBlock(block: unknown): block is ContentBlock & { type: "image"; data: string } {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as ContentBlock;
  return rec.type === "image" && typeof rec.data === "string";
}

function getMessageContent(msg: AgentMessage): unknown[] | null {
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const rec = msg as { content?: unknown };
  if (Array.isArray(rec.content)) {
    return rec.content;
  }
  return null;
}

function hasImageContent(msg: AgentMessage): boolean {
  const content = getMessageContent(msg);
  if (!content) {
    return false;
  }
  return content.some(isImageBlock);
}

function estimateImageDataBytes(data: string): number {
  // Strip data URL prefix if present (e.g., "data:image/png;base64,")
  let base64Data = data;
  const dataUrlMatch = data.match(/^data:[^;]+;base64,/);
  if (dataUrlMatch) {
    base64Data = data.slice(dataUrlMatch[0].length);
  }

  // Remove padding characters and newlines which don't contribute to decoded size
  const cleanData = base64Data.replace(/[=\s]/g, "");

  // Base64 encoding overhead is ~4/3, so actual bytes = chars * 3/4
  return Math.round((cleanData.length * 3) / 4);
}

function createImagePlaceholder(
  block: ContentBlock & { type: "image"; data: string },
): ContentBlock {
  const sizeBytes = estimateImageDataBytes(block.data);
  const sizeKb = Math.round(sizeBytes / 1024);
  const mimeType = block.mimeType ?? "image";

  // Preserve safe metadata fields from the original block, excluding data
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { data: _data, type: _type, text: _text, ...metadata } = block;

  return {
    ...metadata,
    type: "text",
    text: `[Image omitted during compaction: ${mimeType}, ~${sizeKb}KB]`,
  };
}

function replaceImagesWithPlaceholders(msg: AgentMessage): AgentMessage {
  const content = getMessageContent(msg);
  if (!content) {
    return msg;
  }

  let hasImages = false;
  const newContent = content.map((block) => {
    if (isImageBlock(block)) {
      hasImages = true;
      return createImagePlaceholder(block);
    }
    return block;
  });

  if (!hasImages) {
    return msg;
  }
  return { ...msg, content: newContent } as AgentMessage;
}

/**
 * Count images and estimate total image data size in messages.
 */
function countImagesInMessages(messages: AgentMessage[]): { count: number; totalBytes: number } {
  let count = 0;
  let totalBytes = 0;
  for (const msg of messages) {
    const content = getMessageContent(msg);
    if (!content) {
      continue;
    }
    for (const block of content) {
      if (isImageBlock(block)) {
        count++;
        totalBytes += estimateImageDataBytes(block.data);
      }
    }
  }
  return { count, totalBytes };
}

/**
 * Strip images from older messages, keeping only recent ones.
 * This prevents sessions from bloating with accumulated screenshots,
 * which can cause 413 Request Entity Too Large errors.
 */
function stripOldImagesFromMessages(
  messages: AgentMessage[],
  opts: { keepRecentCount?: number } = {},
): {
  messages: AgentMessage[];
  strippedCount: number;
  strippedBytes: number;
} {
  const keepRecentCount = opts.keepRecentCount ?? KEEP_RECENT_IMAGES_COUNT;

  // Find indices of messages with images, from the end (most recent)
  const indicesWithImages: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasImageContent(messages[i])) {
      indicesWithImages.push(i);
    }
  }

  // Keep images in the last N messages that have them
  const keepIndices = new Set(indicesWithImages.slice(0, keepRecentCount));

  let strippedCount = 0;
  let strippedBytes = 0;
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (keepIndices.has(i) || !hasImageContent(msg)) {
      result.push(msg);
      continue;
    }

    // Strip images from this message
    const content = getMessageContent(msg);
    if (content) {
      for (const block of content) {
        if (isImageBlock(block)) {
          strippedCount++;
          strippedBytes += estimateImageDataBytes(block.data);
        }
      }
    }
    result.push(replaceImagesWithPlaceholders(msg));
  }

  return { messages: result, strippedCount, strippedBytes };
}

// ============================================================================
// Tool Failure Tracking
// ============================================================================

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

      // === IMAGE STRIPPING (prevents 413 session bloat) ===
      // Strip images from older messages before summarization to reduce payload size.
      // This addresses the issue where accumulated screenshots cause 413 Request Entity
      // Too Large errors by replacing old image data with lightweight text placeholders.
      //
      // Important: We must strip from BOTH messagesToSummarize AND turnPrefixMessages,
      // with the "keep N most recent" logic applied across the combined list (since
      // turnPrefixMessages come after messagesToSummarize chronologically).
      const allMessagesForImages = [...messagesToSummarize, ...turnPrefixMessages];
      const imageStats = countImagesInMessages(allMessagesForImages);

      let strippedTurnPrefixMessages = turnPrefixMessages;

      if (imageStats.count > 0) {
        const imagesMb = (imageStats.totalBytes / 1024 / 1024).toFixed(2);
        console.log(
          `Compaction safeguard: session has ${imageStats.count} images (~${imagesMb}MB). ` +
            `Stripping old images, keeping ${KEEP_RECENT_IMAGES_COUNT} recent.`,
        );

        // Strip images across the combined list to ensure "keep N most recent" applies globally
        const strippedResult = stripOldImagesFromMessages(allMessagesForImages, {
          keepRecentCount: KEEP_RECENT_IMAGES_COUNT,
        });

        // Re-split the stripped messages back into the two arrays
        const splitPoint = messagesToSummarize.length;
        messagesToSummarize = strippedResult.messages.slice(0, splitPoint);
        strippedTurnPrefixMessages = strippedResult.messages.slice(splitPoint);

        if (strippedResult.strippedCount > 0) {
          const strippedMb = (strippedResult.strippedBytes / 1024 / 1024).toFixed(2);
          console.log(
            `Compaction safeguard: stripped ${strippedResult.strippedCount} images (~${strippedMb}MB).`,
          );
        }
      }
      // === END IMAGE STRIPPING ===

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) +
          estimateMessagesTokens(strippedTurnPrefixMessages);
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
      const allMessages = [...messagesToSummarize, ...strippedTurnPrefixMessages];
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
      if (preparation.isSplitTurn && strippedTurnPrefixMessages.length > 0) {
        const prefixSummary = await summarizeInStages({
          messages: strippedTurnPrefixMessages,
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
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  // Image stripping functions (for 413 session bloat prevention)
  stripOldImagesFromMessages,
  countImagesInMessages,
  replaceImagesWithPlaceholders,
  createImagePlaceholder,
  estimateImageDataBytes,
  hasImageContent,
  KEEP_RECENT_IMAGES_COUNT,
} as const;
