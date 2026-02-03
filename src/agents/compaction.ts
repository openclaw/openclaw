import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import { convertToLlm, estimateTokens, serializeConversation } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS =
  "Merge these partial summaries into a single cohesive summary. Preserve decisions," +
  " TODOs, open questions, and any constraints.";

// ---------------------------------------------------------------------------
// Enhanced summarization prompts with "Immediate Context" section
// ---------------------------------------------------------------------------
// These replace the upstream pi-coding-agent prompts to add recency awareness.
// The key addition is "## Immediate Context" which captures what was being
// actively discussed/worked on in the most recent messages, solving the problem
// of losing the "last thing we were doing" after compaction.

const ENHANCED_SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation " +
  "between a user and an AI assistant, then produce a structured summary following " +
  "the exact format specified.\n\n" +
  "Do NOT continue the conversation. Do NOT respond to any questions in the " +
  "conversation. ONLY output the structured summary.";

const ENHANCED_SUMMARIZATION_PROMPT =
  "The messages above are a conversation to summarize. Create a structured context " +
  "checkpoint summary that another LLM will use to continue the work.\n\n" +
  "Use this EXACT format:\n\n" +
  "## Immediate Context\n" +
  "[What was the user MOST RECENTLY asking about or working on? Describe the active " +
  "conversation topic from the last few exchanges in detail. Include any pending " +
  "questions, partial results, or the exact state of the task right before this " +
  "summary. This section should read like a handoff note: 'You were just working " +
  "on X, the user asked Y, and you were in the middle of Z.']\n\n" +
  "## Goal\n" +
  "[What is the user trying to accomplish? Can be multiple items if the session " +
  "covers different tasks.]\n\n" +
  "## Constraints & Preferences\n" +
  "- [Any constraints, preferences, or requirements mentioned by user]\n" +
  '- [Or "(none)" if none were mentioned]\n\n' +
  "## Progress\n" +
  "### Done\n" +
  "- [x] [Completed tasks/changes]\n\n" +
  "### In Progress\n" +
  "- [ ] [Current work]\n\n" +
  "### Blocked\n" +
  "- [Issues preventing progress, if any]\n\n" +
  "## Key Decisions\n" +
  "- **[Decision]**: [Brief rationale]\n\n" +
  "## Next Steps\n" +
  "1. [Ordered list of what should happen next]\n\n" +
  "## Critical Context\n" +
  "- [Any data, examples, or references needed to continue]\n" +
  '- [Or "(none)" if not applicable]\n\n' +
  "Keep each section concise. Preserve exact file paths, function names, and error messages.";

const ENHANCED_UPDATE_SUMMARIZATION_PROMPT =
  "The messages above are NEW conversation messages to incorporate into the existing " +
  "summary provided in <previous-summary> tags.\n\n" +
  "Update the existing structured summary with new information. RULES:\n" +
  "- REPLACE the Immediate Context section entirely with what the NEWEST messages " +
  "are about — this must always reflect the most recent conversation topic\n" +
  "- PRESERVE all existing information from the previous summary in other sections\n" +
  "- ADD new progress, decisions, and context from the new messages\n" +
  '- UPDATE the Progress section: move items from "In Progress" to "Done" when completed\n' +
  '- UPDATE "Next Steps" based on what was accomplished\n' +
  "- PRESERVE exact file paths, function names, and error messages\n" +
  "- If something is no longer relevant, you may remove it\n\n" +
  "Use this EXACT format:\n\n" +
  "## Immediate Context\n" +
  "[What is the conversation CURRENTLY about based on these newest messages? " +
  "Describe the active topic, any pending questions, and the exact state of work. " +
  "This REPLACES any previous immediate context — always reflect the latest exchanges.]\n\n" +
  "## Goal\n" +
  "[Preserve existing goals, add new ones if the task expanded]\n\n" +
  "## Constraints & Preferences\n" +
  "- [Preserve existing, add new ones discovered]\n\n" +
  "## Progress\n" +
  "### Done\n" +
  "- [x] [Include previously done items AND newly completed items]\n\n" +
  "### In Progress\n" +
  "- [ ] [Current work - update based on progress]\n\n" +
  "### Blocked\n" +
  "- [Current blockers - remove if resolved]\n\n" +
  "## Key Decisions\n" +
  "- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n" +
  "## Next Steps\n" +
  "1. [Update based on current state]\n\n" +
  "## Critical Context\n" +
  "- [Preserve important context, add new if needed]\n\n" +
  "Keep each section concise. Preserve exact file paths, function names, and error messages.";

/**
 * Enhanced version of generateSummary that includes an "Immediate Context" section
 * in the compaction summary. This ensures that the most recent conversation topic
 * is prominently captured, solving the "can't remember what we were just doing"
 * problem after compaction.
 */
async function generateSummary(
  currentMessages: AgentMessage[],
  model: NonNullable<ExtensionContext["model"]>,
  reserveTokens: number,
  apiKey: string,
  signal: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
): Promise<string> {
  const maxTokens = Math.floor(0.8 * reserveTokens);

  // Use update prompt if we have a previous summary, otherwise initial prompt
  let basePrompt = previousSummary
    ? ENHANCED_UPDATE_SUMMARIZATION_PROMPT
    : ENHANCED_SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }

  // Serialize conversation to text so model doesn't try to continue it
  // Use type assertion since convertToLlm accepts AgentMessage[] at runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const llmMessages = convertToLlm(currentMessages as any);
  const conversationText = serializeConversation(llmMessages);

  // Build the prompt with conversation wrapped in tags
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  // Build user message for summarization request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summarizationMessages: any[] = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now(),
    },
  ];

  const response = await completeSimple(
    model,
    {
      systemPrompt: ENHANCED_SUMMARIZATION_SYSTEM_PROMPT,
      messages: summarizationMessages,
    },
    { maxTokens, signal, apiKey, reasoning: "high" },
  );

  if (response.stopReason === "error") {
    throw new Error(
      `Summarization failed: ${
        (response as { errorMessage?: string }).errorMessage || "Unknown error"
      }`,
    );
  }

  // Extract text content from response
  const textContent = (response.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");

  return textContent;
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function chunkMessagesByMaxTokens(
  messages: AgentMessage[],
  maxTokens: number,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateTokens(message);
    if (currentChunk.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;

    if (messageTokens > maxTokens) {
      // Split oversized messages to avoid unbounded chunk growth.
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;

  // Apply safety margin to account for estimation inaccuracy
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

async function summarizeChunks(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
  let summary = params.previousSummary;

  for (const chunk of chunks) {
    summary = await generateSummary(
      chunk,
      params.model,
      params.reserveTokens,
      params.apiKey,
      params.signal,
      params.customInstructions,
      summary,
    );
  }

  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
export async function summarizeWithFallback(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  const { messages, contextWindow } = params;

  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Try full summarization first
  try {
    return await summarizeChunks(params);
  } catch (fullError) {
    console.warn(
      `Full summarization failed, trying partial: ${
        fullError instanceof Error ? fullError.message : String(fullError)
      }`,
    );
  }

  // Fallback 1: Summarize only small messages, note oversized ones
  const smallMessages: AgentMessage[] = [];
  const oversizedNotes: string[] = [];

  for (const msg of messages) {
    if (isOversizedForSummary(msg, contextWindow)) {
      const role = (msg as { role?: string }).role ?? "message";
      const tokens = estimateTokens(msg);
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
      );
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partialSummary = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partialSummary + notes;
    } catch (partialError) {
      console.warn(
        `Partial summarization also failed: ${
          partialError instanceof Error ? partialError.message : String(partialError)
        }`,
      );
    }
  }

  // Final fallback: Just note what was there
  return (
    `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). ` +
    `Summary unavailable due to size limits.`
  );
}

export async function summarizeInStages(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      }),
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  const summaryMessages: AgentMessage[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

export function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const maxHistoryShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = params.messages;
  const allDroppedMessages: AgentMessage[] = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;

  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) {
      break;
    }
    const [dropped, ...rest] = chunks;
    droppedChunks += 1;
    droppedMessages += dropped.length;
    droppedTokens += estimateMessagesTokens(dropped);
    allDroppedMessages.push(...dropped);
    keptMessages = rest.flat();
  }

  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}

export function resolveContextWindowTokens(model?: ExtensionContext["model"]): number {
  return Math.max(1, Math.floor(model?.contextWindow ?? DEFAULT_CONTEXT_TOKENS));
}
