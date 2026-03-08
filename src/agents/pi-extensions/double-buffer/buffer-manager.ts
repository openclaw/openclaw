/**
 * Double-buffered context window manager.
 *
 * Implements a double-buffering scheme for LLM context windows inspired by
 * GPU back-buffer swapping. The active buffer serves the agent while a back
 * buffer is prepared in the background so that context-window "hops" are
 * nearly seamless.
 *
 * Algorithm phases:
 *   1. **Checkpoint** - at `checkpointThreshold` capacity, kick off background
 *      summarization and seed the back buffer. The agent keeps working.
 *   2. **Concurrent** - new messages are appended to *both* active and back
 *      buffers so no work is lost during summarization.
 *   3. **Swap** - at `swapThreshold` capacity, swap to the back buffer. If the
 *      background summarization is not yet complete, block on it (graceful
 *      degradation to stop-the-world).
 *
 * By default `maxGenerations` is `undefined` (renewal disabled), so each
 * checkpoint produces a fresh summary without building on previous ones.
 * Set `maxGenerations` to a number to enable incremental summary
 * accumulation and periodic meta-summarization.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  SUMMARIZATION_OVERHEAD_TOKENS,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  summarizeInStages,
} from "../../compaction.js";
import { stripToolResultDetails } from "../../session-transcript-repair.js";
import type { EffectiveDoubleBufferSettings } from "./settings.js";

const log = createSubsystemLogger("double-buffer");

/**
 * Snapshot of a single buffer: a summary prefix plus live messages that
 * arrived after the summary was produced.
 */
export type BufferState = {
  summary: string | undefined;
  messages: AgentMessage[];
};

/** Accumulated summary chain across buffer generations. */
export type SummaryChain = {
  summaries: string[];
  generation: number;
};

/** Observable state exposed for testing and diagnostics. */
export type BufferManagerSnapshot = {
  hasBackBuffer: boolean;
  activeBuffer: Readonly<BufferState>;
  backBuffer: Readonly<BufferState> | null;
  summaryChain: Readonly<SummaryChain>;
  checkpointInFlight: boolean;
};

/** Dependencies injected into the buffer manager (avoids hard coupling). */
export type BufferManagerDeps = {
  /** Summarize a set of messages, returning a text summary. */
  summarize: (params: {
    messages: AgentMessage[];
    previousSummary: string | undefined;
    signal: AbortSignal;
  }) => Promise<string>;
};

/**
 * Build a `summarize` function from the model/apiKey available in the
 * extension context, matching the signature expected by `BufferManagerDeps`.
 */
export function buildSummarizeDep(params: {
  model: Model<Api>;
  apiKey: string;
  contextWindowTokens: number;
  customInstructions: string | undefined;
}): BufferManagerDeps["summarize"] {
  const { model, apiKey, contextWindowTokens, customInstructions } = params;
  return async ({ messages, previousSummary, signal }) => {
    const safeMessages = stripToolResultDetails(messages);
    const chunkRatio = computeAdaptiveChunkRatio(safeMessages, contextWindowTokens);
    const maxChunkTokens = Math.max(
      1,
      Math.floor(contextWindowTokens * chunkRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
    );
    return summarizeInStages({
      messages: safeMessages,
      model,
      apiKey,
      signal,
      reserveTokens: Math.max(1, Math.floor(contextWindowTokens * 0.1)),
      maxChunkTokens,
      contextWindow: contextWindowTokens,
      customInstructions,
      previousSummary,
    });
  };
}

export class BufferManager {
  private readonly settings: EffectiveDoubleBufferSettings;
  private readonly contextWindowTokens: number;
  private readonly deps: BufferManagerDeps;

  // --- Mutable state ---
  private activeBuffer: BufferState = { summary: undefined, messages: [] };
  private backBuffer: BufferState | null = null;
  private summaryChain: SummaryChain = { summaries: [], generation: 0 };

  /** The in-flight checkpoint promise (non-null only during checkpoint/concurrent phases). */
  private checkpointPromise: Promise<string> | null = null;
  private checkpointAbort: AbortController | null = null;

  constructor(params: {
    settings: EffectiveDoubleBufferSettings;
    contextWindowTokens: number;
    deps: BufferManagerDeps;
    /** Optionally seed with a prior summary (e.g. from a previous compaction). */
    initialSummary?: string;
  }) {
    this.settings = params.settings;
    this.contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
    this.deps = params.deps;

    if (params.initialSummary) {
      this.activeBuffer.summary = params.initialSummary;
      this.summaryChain.summaries.push(params.initialSummary);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Return a diagnostic snapshot (read-only). */
  snapshot(): BufferManagerSnapshot {
    return {
      hasBackBuffer: this.backBuffer !== null,
      activeBuffer: this.activeBuffer,
      backBuffer: this.backBuffer,
      summaryChain: { ...this.summaryChain, summaries: [...this.summaryChain.summaries] },
      checkpointInFlight: this.checkpointPromise !== null,
    };
  }

  /**
   * Observe an incoming message. This drives the state machine:
   *   - Appends the message to the active buffer (always).
   *   - In concurrent phase, also appends to the back buffer.
   *   - Checks thresholds and triggers checkpoint/swap as needed.
   *
   * Returns the messages the agent should use for the current turn.
   * When a swap occurs, the returned array reflects the new (swapped) buffer.
   */
  async onMessage(message: AgentMessage): Promise<AgentMessage[]> {
    // Always append to active buffer.
    this.activeBuffer.messages.push(message);

    // During concurrent phase, mirror to back buffer.
    if (this.backBuffer) {
      this.backBuffer.messages.push(message);
    }

    const usage = this.currentUsageRatio();

    // --- Check swap threshold first (higher priority). ---
    if (this.backBuffer && usage >= this.settings.swapThreshold) {
      return this.executeSwap();
    }

    // --- Check checkpoint threshold. ---
    if (!this.backBuffer && !this.checkpointPromise && usage >= this.settings.checkpointThreshold) {
      this.startCheckpoint();
    }

    return this.getActiveMessages();
  }

  /**
   * Retrieve the full message list the agent should send to the LLM,
   * prefixed with the active buffer's summary as a system-ish user message.
   */
  getActiveMessages(): AgentMessage[] {
    return this.buildMessageList(this.activeBuffer);
  }

  /** Cancel any in-flight checkpoint (e.g. on session teardown). */
  cancel(): void {
    if (this.checkpointAbort) {
      this.checkpointAbort.abort();
      this.checkpointAbort = null;
    }
    this.checkpointPromise = null;
    if (this.backBuffer) {
      log.info(`Checkpoint cancelled; discarding back buffer.`);
      this.backBuffer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: threshold helpers
  // ---------------------------------------------------------------------------

  /** Estimate current active-buffer token usage as a ratio of the context window. */
  currentUsageRatio(): number {
    const tokens = this.estimateBufferTokens(this.activeBuffer);
    return tokens / this.contextWindowTokens;
  }

  private estimateBufferTokens(buffer: BufferState): number {
    let tokens = estimateMessagesTokens(buffer.messages);
    if (buffer.summary) {
      // Approximate the summary token cost.
      tokens += Math.ceil(buffer.summary.length / 4);
    }
    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Internal: checkpoint (Phase 1 -> Phase 2)
  // ---------------------------------------------------------------------------

  private startCheckpoint(): void {
    if (this.backBuffer) {
      return;
    }
    log.info(
      `Checkpoint triggered at ${(this.currentUsageRatio() * 100).toFixed(1)}% capacity ` +
        `(threshold: ${(this.settings.checkpointThreshold * 100).toFixed(0)}%). ` +
        `Starting background summarization.`,
    );

    // Snapshot messages to summarize (everything in active buffer so far).
    const messagesToSummarize = [...this.activeBuffer.messages];
    const previousSummary = this.resolveAccumulatedSummary();

    // Seed back buffer: starts with no messages yet (concurrent messages will be added).
    this.backBuffer = { summary: undefined, messages: [] };

    const abort = new AbortController();
    this.checkpointAbort = abort;

    this.checkpointPromise = this.deps
      .summarize({
        messages: messagesToSummarize,
        previousSummary,
        signal: abort.signal,
      })
      .then((summary) => {
        if (abort.signal.aborted) {
          return summary;
        }
        log.info(
          `Background summarization complete (${summary.length} chars). ` +
            `Back buffer ready for swap.`,
        );
        // Attach summary to back buffer.
        if (this.backBuffer) {
          this.backBuffer.summary = summary;
        }
        // Accumulate into chain.
        this.summaryChain.summaries.push(summary);
        this.summaryChain.generation += 1;
        return summary;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Background summarization failed: ${message}. Swap will degrade gracefully.`);
        // On failure: back buffer has no summary. Swap will still work,
        // but the back buffer will just carry over the old accumulated summary.
        if (this.backBuffer) {
          this.backBuffer.summary = this.resolveAccumulatedSummary();
        }
        return this.backBuffer?.summary ?? "";
      });
  }

  // ---------------------------------------------------------------------------
  // Internal: swap (Phase 2/3)
  // ---------------------------------------------------------------------------

  private async executeSwap(): Promise<AgentMessage[]> {
    log.info(
      `Swap triggered at ${(this.currentUsageRatio() * 100).toFixed(1)}% capacity ` +
        `(threshold: ${(this.settings.swapThreshold * 100).toFixed(0)}%).`,
    );

    // If the checkpoint is still running, block on it (graceful degradation).
    if (this.checkpointPromise) {
      const hasBackBufferSummary = this.backBuffer?.summary !== undefined;
      if (!hasBackBufferSummary) {
        log.warn(
          `Back buffer summary not ready; blocking on checkpoint ` +
            `(graceful degradation to stop-the-world).`,
        );
      }
      try {
        await this.checkpointPromise;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          `Blocked checkpoint failed during swap: ${message}. Continuing without new summary.`,
        );
      }
      this.checkpointPromise = null;
      this.checkpointAbort = null;
    }

    // Handle generation overflow: meta-summarize if needed.
    await this.maybeMetaSummarize();

    // Perform the swap.
    if (this.backBuffer) {
      this.activeBuffer = this.backBuffer;
      this.backBuffer = null;
      log.info(
        `Buffer swapped. New active buffer has ${this.activeBuffer.messages.length} messages ` +
          `and summary of ${this.activeBuffer.summary?.length ?? 0} chars.`,
      );
    } else {
      // Edge case: no back buffer (e.g. checkpoint was cancelled). Continue with active.
      log.warn(`No back buffer available during swap; continuing with current active buffer.`);
    }

    return this.getActiveMessages();
  }

  // ---------------------------------------------------------------------------
  // Internal: summary accumulation / meta-summarization
  // ---------------------------------------------------------------------------

  private resolveAccumulatedSummary(): string | undefined {
    if (this.summaryChain.summaries.length === 0) {
      return undefined;
    }
    return this.summaryChain.summaries.join("\n\n---\n\n");
  }

  private async maybeMetaSummarize(): Promise<void> {
    if (
      this.settings.maxGenerations == null ||
      this.summaryChain.generation < this.settings.maxGenerations
    ) {
      return;
    }

    log.info(
      `Summary chain reached ${this.summaryChain.generation} generations ` +
        `(max: ${this.settings.maxGenerations}). Meta-summarizing.`,
    );

    const accumulated = this.resolveAccumulatedSummary();
    if (!accumulated) {
      return;
    }

    try {
      const metaMessage: AgentMessage = {
        role: "user",
        content: accumulated,
        timestamp: Date.now(),
      };
      const abort = new AbortController();
      const metaSummary = await this.deps.summarize({
        messages: [metaMessage],
        previousSummary: undefined,
        signal: abort.signal,
      });

      // Reset the chain with the meta-summary.
      this.summaryChain = { summaries: [metaSummary], generation: 1 };

      // Update back buffer summary to the meta-summary.
      if (this.backBuffer) {
        this.backBuffer.summary = metaSummary;
      }

      log.info(`Meta-summarization complete (${metaSummary.length} chars). Chain reset.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        `Meta-summarization failed: ${message}. Falling back to clean restart ` +
          `(discarding oldest summaries).`,
      );
      // Fallback: keep only the most recent summary.
      const latest = this.summaryChain.summaries.at(-1);
      this.summaryChain = {
        summaries: latest ? [latest] : [],
        generation: latest ? 1 : 0,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: message list construction
  // ---------------------------------------------------------------------------

  private buildMessageList(buffer: BufferState): AgentMessage[] {
    if (!buffer.summary) {
      return buffer.messages;
    }

    const summaryMessage: AgentMessage = {
      role: "user",
      content:
        `<context-summary generation="${this.summaryChain.generation}">\n` +
        `${buffer.summary}\n` +
        `</context-summary>`,
      timestamp: 0,
    };

    return [summaryMessage, ...buffer.messages];
  }
}
