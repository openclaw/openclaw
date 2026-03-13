/**
 * Conversation Stack (Rolling Summary)
 *
 * Compresses each conversation turn (User + Assistant) into a ~30-word summary
 * and accumulates them into a session-scoped stack. This allows the plugin to
 * understand the FULL conversation context without exceeding the model's
 * context window (e.g., 15k tokens for Gemma 3).
 *
 * Architecture:
 *   Turn 1: "User asked about bugs" (compressed from 500 words to 30)
 *   Turn 2: "User approved the fix" (compressed from 300 words to 30)
 *   Turn 3: "User wants new feature" (compressed from 800 words to 30)
 *   → Total context: ~90 words instead of ~1600 words (17x compression)
 *
 * Academic References:
 *  - MemGPT: "Towards LLMs as Operating Systems" (Packer et al., UC Berkeley, 2023)
 *  - "Recursively Summarizing Enables Long-Term Dialogue Memory" (Wang et al., 2023, Neurocomputing)
 *
 * @module stack
 */

import type { ChatModel } from "./chat.js";

/** Minimum message length to be worth compressing (skip "ok", "👍", etc.) */
const MIN_MESSAGE_LENGTH = 10;

/** A single compressed conversation turn */
export interface CompressedTurn {
  /** The compressed summary of this turn (~30 words) */
  summary: string;
  /** Timestamp when this turn was compressed */
  timestamp: number;
}

/**
 * ConversationStack accumulates compressed summaries of each conversation turn.
 *
 * Usage:
 *   const stack = new ConversationStack(30);
 *   await stack.push(userMsg, assistantMsg, chatModel);
 *   const context = stack.getContextBlock(); // → "<conversation-summary>...</conversation-summary>"
 */
export class ConversationStack {
  private turns: CompressedTurn[] = [];

  /**
   * @param maxTurns - Maximum number of compressed turns to keep (FIFO eviction).
   *                   Default 30 turns × ~30 words = ~900 words max.
   */
  constructor(private readonly maxTurns: number = 30) {}

  /** Number of compressed turns currently in the stack */
  get turnCount(): number {
    return this.turns.length;
  }

  /** Whether the stack has zero turns */
  get isEmpty(): boolean {
    return this.turns.length === 0;
  }

  /**
   * Compress a conversation turn (User + Assistant) and push it onto the stack.
   *
   * Skips trivial messages (< 10 chars) to save API quota.
   * If LLM compression fails, falls back to truncated original text.
   *
   * @param userMessage - The user's message
   * @param assistantMessage - The assistant's response
   * @param chatModel - The LLM model used for compression
   */
  async push(userMessage: string, assistantMessage: string, chatModel: ChatModel): Promise<void> {
    // Skip trivial messages
    if (userMessage.length < MIN_MESSAGE_LENGTH && assistantMessage.length < MIN_MESSAGE_LENGTH) {
      return;
    }

    let summary: string;

    try {
      const prompt = `Compress this conversation turn into ONE concise sentence (max 40 words). Preserve key facts, decisions, names, and emotions. Drop greetings and filler.

USER: "${userMessage.slice(0, 2000)}"
ASSISTANT: "${assistantMessage.slice(0, 1000)}"

Return ONLY the compressed sentence, nothing else.`;

      summary = await chatModel.complete([{ role: "user", content: prompt }], false);
      summary = summary.trim().slice(0, 200); // Safety cap
    } catch {
      // Fallback: truncate original text if LLM fails
      summary = `[U] ${userMessage.slice(0, 60)}... [A] ${assistantMessage.slice(0, 60)}...`;
    }

    this.turns.push({
      summary,
      timestamp: Date.now(),
    });

    // FIFO eviction: remove oldest turns if we exceed maxTurns
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }

  /**
   * Get all compressed summaries joined as a single string.
   * Returns empty string if no turns are stored.
   */
  getSummary(): string {
    if (this.turns.length === 0) return "";
    return this.turns.map((t, i) => `${i + 1}. ${t.summary}`).join("\n");
  }

  /**
   * Get the stack formatted as a context block for injection into prompts.
   * Wrapped in `<conversation-summary>` tags so the LLM knows it's metadata.
   */
  getContextBlock(): string {
    if (this.turns.length === 0) return "";
    return `<conversation-summary>\nCompressed history of the current conversation (${this.turns.length} turns):\n${this.getSummary()}\n</conversation-summary>`;
  }

  /** Clear all turns (e.g., on session reset) */
  reset(): void {
    this.turns = [];
  }
}
