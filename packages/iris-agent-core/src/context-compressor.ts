/**
 * Age-based tool result compressor.
 *
 * Reduces context bloat by truncating ToolResultMessage text content for
 * messages in old turns. "Old" = older than ageTurns from the most recent
 * user message.
 *
 * Runs as a built-in pre-pass in streamAssistantResponse, before the
 * user-supplied transformContext hook.
 */
import type { AgentMessage } from "./types.js";

export interface ToolResultCompressionOptions {
  /** How many user-turns from the end to keep uncompressed. Default: 3 */
  ageTurns?: number;
  /** Max characters per tool result before truncation. Default: 200 */
  maxChars?: number;
}

const COMPRESSION_LABEL = "aged-out";

function isToolResultMessage(msg: AgentMessage): boolean {
  return (msg as { role?: string }).role === "toolResult";
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

/**
 * Compresses tool result messages older than `ageTurns` user-turns.
 * Returns a new array; never mutates the originals.
 */
export function compressAgedToolResults(
  messages: AgentMessage[],
  opts: ToolResultCompressionOptions = {},
): AgentMessage[] {
  const ageTurns = opts.ageTurns ?? 3;
  const maxChars = opts.maxChars ?? 200;

  // Locate user-message indices (each marks a turn boundary)
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as { role?: string }).role === "user") {
      userIndices.push(i);
    }
  }

  // Not enough turns to compress anything
  if (userIndices.length <= ageTurns) {
    return messages;
  }

  // Messages before this index are in "old" turns
  const cutoff = userIndices[userIndices.length - ageTurns];

  const result: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i >= cutoff || !isToolResultMessage(msg)) {
      result.push(msg);
      continue;
    }

    // Gather text blocks from this old tool result
    const rawContent = ((msg as { content?: unknown }).content ?? []) as unknown[];
    const textBlocks = rawContent.filter(isTextBlock);
    const totalChars = textBlocks.reduce((sum, b) => sum + b.text.length, 0);

    if (totalChars <= maxChars) {
      result.push(msg);
      continue;
    }

    // Keep the first maxChars, append a truncation notice
    const head = (textBlocks[0]?.text ?? "").slice(0, maxChars);
    const leftover = totalChars - head.length;
    const compressedContent = [
      {
        type: "text" as const,
        text: `${head}…[+${leftover} chars, ${COMPRESSION_LABEL}]`,
      },
    ];

    result.push({ ...msg, content: compressedContent } as AgentMessage);
  }

  return result;
}
