import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

interface ContextTransferData {
  timestamp: string;
  expiresAt: string;
  nextActions: Array<{
    priority: number;
    action: string;
    context?: string;
  }>;
  doNotTouch: string[];
  activeTasks: Array<{
    description: string;
    status: "in-progress" | "blocked" | "waiting";
    references: string[];
  }>;
  pendingDecisions: string[];
  subAgents: Array<{
    label: string;
    sessionKey: string;
    status: "running" | "idle" | "done";
  }>;
  ephemeralIds: Record<string, string>;
  conversationMode: "deep-work" | "casual" | "debugging";
}

const CONTEXT_EXTRACTION_PROMPT = `You are analyzing a conversation history to extract structured context for session handover.

Based on the conversation, extract:
1. **Active Tasks**: Any work that's in progress, blocked, or waiting (with status and relevant references like issue numbers, file paths)
2. **Pending Decisions**: Questions waiting for user input or choices that haven't been made yet
3. **Sub-Agents**: Any spawned sub-agent sessions (with label, session key, and status)
4. **Ephemeral IDs**: Message IDs, channel IDs, embed IDs, or other temporary identifiers mentioned (with purpose labels)
5. **Next Actions**: Prescriptive steps for what should happen next (prioritized, with context)
6. **Do-Not-Touch Items**: Things that should be left alone with reasons why
7. **Conversation Mode**: Whether this is deep-work, casual conversation, or debugging

Return ONLY a valid JSON object matching this schema:
{
  "nextActions": [{"priority": 1-5, "action": "...", "context": "..."}],
  "doNotTouch": ["reason why X should not be touched"],
  "activeTasks": [{"description": "...", "status": "in-progress|blocked|waiting", "references": ["..."]}],
  "pendingDecisions": ["..."],
  "subAgents": [{"label": "...", "sessionKey": "...", "status": "running|idle|done"}],
  "ephemeralIds": {"purpose": "id"},
  "conversationMode": "deep-work|casual|debugging"
}

If any section is empty, use an empty array or object. Be concise but capture critical context.`;

/**
 * Condense AgentMessages into a compact text representation for the extraction prompt.
 * Only includes the last N messages and strips large tool results to save tokens.
 */
function condenseMessagesForExtraction(messages: AgentMessage[], maxMessages = 60): string {
  const recent = messages.slice(-maxMessages);
  const lines: string[] = [];

  for (const msg of recent) {
    const role = (msg as { role?: string }).role ?? "unknown";
    if (role === "user") {
      const content =
        typeof (msg as { content?: unknown }).content === "string"
          ? (msg as { content: string }).content
          : Array.isArray((msg as { content?: unknown }).content)
            ? ((msg as { content: Array<{ type?: string; text?: string }> }).content ?? [])
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("\n")
            : "";
      if (content.trim()) {
        lines.push(`[USER] ${content.slice(0, 500)}`);
      }
    } else if (role === "assistant") {
      const content = (msg as { content?: unknown }).content;
      const text = Array.isArray(content)
        ? content
            .filter((b: { type?: string }) => b.type === "text")
            .map((b: { text?: string }) => b.text ?? "")
            .join("\n")
        : typeof content === "string"
          ? content
          : "";
      if (text.trim()) {
        lines.push(`[ASSISTANT] ${text.slice(0, 500)}`);
      }
    } else if (role === "toolResult") {
      const toolName = (msg as { toolName?: string }).toolName ?? "tool";
      const isError = (msg as { isError?: boolean }).isError;
      const resultText = extractToolResultText((msg as { content?: unknown }).content);
      const truncated = resultText.slice(0, 200);
      lines.push(`[TOOL:${toolName}${isError ? " ERROR" : ""}] ${truncated}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a ContextTransferData object from extracted JSON, with safe defaults.
 */
function buildContextTransfer(extracted: Record<string, unknown>): ContextTransferData {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour TTL

  return {
    timestamp: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nextActions: Array.isArray(extracted.nextActions) ? extracted.nextActions : [],
    doNotTouch: Array.isArray(extracted.doNotTouch) ? extracted.doNotTouch : [],
    activeTasks: Array.isArray(extracted.activeTasks) ? extracted.activeTasks : [],
    pendingDecisions: Array.isArray(extracted.pendingDecisions) ? extracted.pendingDecisions : [],
    subAgents: Array.isArray(extracted.subAgents) ? extracted.subAgents : [],
    ephemeralIds:
      extracted.ephemeralIds != null && typeof extracted.ephemeralIds === "object"
        ? (extracted.ephemeralIds as Record<string, string>)
        : {},
    conversationMode: ["deep-work", "casual", "debugging"].includes(
      extracted.conversationMode as string,
    )
      ? (extracted.conversationMode as ContextTransferData["conversationMode"])
      : "casual",
  };
}

/**
 * Parse JSON from an LLM response, handling responses that include extra text
 * around the JSON object.
 */
function parseJsonFromResponse(text: string): Record<string, unknown> | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/** The Sonnet model ID to use for context extraction */
const EXTRACTION_MODEL_ID = "claude-sonnet-4-20250514" as const;

async function extractAndWriteContextTransfer(
  messages: AgentMessage[],
  apiKey: string,
  workspaceDir: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    // Use Sonnet for extraction: fast, cheap, sufficient for structured extraction
    const extractionModel = getModel("anthropic", EXTRACTION_MODEL_ID);

    const condensed = condenseMessagesForExtraction(messages);
    if (!condensed.trim()) {
      console.log("Context extraction: no substantive messages to extract from, skipping");
      return;
    }

    const result = await completeSimple(
      extractionModel,
      {
        systemPrompt: CONTEXT_EXTRACTION_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `Conversation history:\n${condensed}` }],
          },
        ],
      },
      {
        apiKey,
        temperature: 0.1,
        maxTokens: 2000,
        signal,
      },
    );

    // Extract text from assistant response
    const responseText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    const extracted = parseJsonFromResponse(responseText);
    if (!extracted) {
      console.warn("Context extraction: No valid JSON found in response, skipping");
      return;
    }

    const contextTransfer = buildContextTransfer(extracted);

    // Write to .context-transfer.json in workspace
    const transferFilePath = join(workspaceDir, ".context-transfer.json");
    writeFileSync(transferFilePath, JSON.stringify(contextTransfer, null, 2), "utf8");

    console.log(`Context transfer data written to ${transferFilePath}`);
  } catch (error) {
    // Graceful failure - log warning but don't break compaction
    console.warn(
      `Failed to extract context transfer data: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

      summary += toolFailureSection;
      summary += fileOpsSummary;

      // Extract and write context transfer data (uses Sonnet, gets its own API key)
      const workspaceDir = ctx.sessionManager.getCwd();
      const extractionApiKey = await ctx.modelRegistry.getApiKey(
        getModel("anthropic", EXTRACTION_MODEL_ID),
      );
      if (extractionApiKey) {
        await extractAndWriteContextTransfer(allMessages, extractionApiKey, workspaceDir, signal);
      } else {
        // Fall back to the session model's API key (likely same provider)
        await extractAndWriteContextTransfer(allMessages, apiKey, workspaceDir, signal);
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
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  condenseMessagesForExtraction,
  buildContextTransfer,
  parseJsonFromResponse,
  CONTEXT_EXTRACTION_PROMPT,
} as const;
