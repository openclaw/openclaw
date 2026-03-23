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

import { MIN_MESSAGE_LENGTH } from "./capture.js";
import { type ChatModel } from "./chat.js";
import { tracer } from "./tracer.js";

/** A single compressed conversation turn */
export interface CompressedTurn {
  /** The compressed summary of this turn or batch (~30-60 words) */
  summary: string;
  /** Timestamp when this turn was compressed */
  timestamp: number;
}

/**
 * ConversationStack accumulates compressed summaries of each conversation turn.
 *
 * Usage:
 *   const stack = new ConversationStack(30, 3);
 *   await stack.push(userMsg, assistantMsg, chatModel);
 *   const context = stack.getContextBlock();
 */
export class ConversationStack {
  private turns: CompressedTurn[] = [];
  private pendingTurns: { user: string; assistant: string }[] = [];

  /**
   * @param maxTurns - Maximum number of compressed turns to keep (FIFO eviction).
   * @param batchSize - Number of turns to buffer before calling LLM for compression.
   *                    Higher = fewer API calls (RPM optimization).
   */
  constructor(
    private readonly maxTurns: number = 30,
    private readonly batchSize: number = 3,
  ) {}

  /** Number of compressed turns currently in the stack */
  get turnCount(): number {
    return this.turns.length;
  }

  /** Whether the stack has zero turns (compressed or pending) */
  get isEmpty(): boolean {
    return this.turns.length === 0 && this.pendingTurns.length === 0;
  }

  /**
   * Add a conversation turn (User + Assistant).
   * Buffers the turn and only compresses when batchSize is reached.
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

    this.pendingTurns.push({
      user: userMessage.slice(0, 2000),
      assistant: assistantMessage.slice(0, 1000),
    });

    if (this.pendingTurns.length >= this.batchSize) {
      await this.flush(chatModel);
    }
  }

  /**
   * Compress all pending turns into a single summary block.
   * This drastically reduces API RPM by consolidating multiple turns.
   */
  async flush(chatModel: ChatModel): Promise<void> {
    if (this.pendingTurns.length === 0) return;

    try {
      const turnsText = this.pendingTurns
        .map((t, i) => `TURN ${i + 1}:\nUSER: "${t.user}"\nASSISTANT: "${t.assistant}"`)
        .join("\n\n");

      const prompt = `Compress these ${this.pendingTurns.length} conversation turns into a few concise sentences (max 60 words total). 
Preserve key facts, decisions, names, and emotional state. Drop greetings and filler.

CONVERSATION:
${turnsText}

Return ONLY the compressed summary, nothing else.`;

      let summary = await chatModel.complete([{ role: "user", content: prompt }], false);
      summary = summary.trim().slice(0, 400); // Safety cap

      tracer.traceSummary(this.pendingTurns.length, summary);

      this.turns.push({
        summary,
        timestamp: Date.now(),
      });

      // FIFO eviction
      while (this.turns.length > this.maxTurns) {
        this.turns.shift();
      }
    } catch {
      // Fallback: simple truncation of the last turn in batch
      const last = this.pendingTurns[this.pendingTurns.length - 1];
      const summary = `[U] ${last.user.slice(0, 60)}... [A] ${last.assistant.slice(0, 60)}...`;
      this.turns.push({ summary, timestamp: Date.now() });
    } finally {
      this.pendingTurns = [];
    }
  }

  /**
   * Get all compressed summaries joined as a single string.
   * Also includes pending (uncompressed) turns for full context.
   */
  getSummary(): string {
    const compressed = this.turns.map((t, i) => `${i + 1}. ${t.summary}`).join("\n");

    if (this.pendingTurns.length === 0) return compressed;

    const pending = this.pendingTurns
      .map((t, i) => `(Pending ${i + 1}) USER: ${t.user.slice(0, 100)}...`)
      .join("\n");

    return compressed ? `${compressed}\n\nRecent (uncompressed):\n${pending}` : pending;
  }

  /**
   * Get the stack formatted as a context block for injection into prompts.
   */
  getContextBlock(): string {
    if (this.isEmpty) return "";

    let text = "Compressed history of the current conversation:\n" + this.getSummary();

    return `<conversation-summary>\n${text}\n</conversation-summary>`;
  }

  /** Clear all turns and pending buffer */
  reset(): void {
    this.turns = [];
    this.pendingTurns = [];
  }
}
