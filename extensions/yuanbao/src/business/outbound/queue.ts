/**
 * Outbound queue (MessageSender-based).
 *
 * Receives a MessageSender instance and dispatches via sender.send(item) / sender.sendText(text).
 * Supports three strategies: immediate, merge-text, mergeOnFlush.
 *
 * Design notes:
 * - QueueSession is a per-session queue instance bound to a MessageSender
 * - push(item) enqueues a message
 * - flush() sends all remaining buffered content, then calls onComplete
 * - abort() cancels the queue, discarding unsent content
 * - Uses MessageSender interface directly, decoupling send logic
 */

import { createLog } from "../../logger.js";
import { mdFence, mdBlock, mdAtomic } from "../utils/markdown.js";
import type { MessageSender, OutboundItem } from "./types.js";

/** Queue session interface */
export interface QueueSession {
  readonly strategy: "immediate" | "merge-text" | "mergeOnFlush";
  push(item: OutboundItem): Promise<void>;
  /** Returns whether any content was sent */
  flush(): Promise<boolean>;
  abort(): void;
  /**
   * Force-flush current buffer immediately without closing the session.
   * Used before tool_call to deliver accumulated text to the user promptly.
   */
  drainNow(): Promise<void>;
}

/** Queue session creation options */
export interface QueueSessionOptions {
  sender: MessageSender;
  strategy: "immediate" | "merge-text";
  /**
   * When enabled, push only buffers; flush merges all text into a single message.
   * Orthogonal to strategy, takes priority over it.
   */
  mergeOnFlush?: boolean;
  onComplete: () => void;
  sessionKey?: string;
  /** Default 2800 */
  minChars?: number;
  /** Default 3000 */
  maxChars?: number;
  /**
   * Markdown-aware text chunking function (fence-aware).
   * Injected by channel.ts using OpenClaw core's chunkMarkdownText.
   * Falls back to even character-count splitting when not provided.
   */
  chunkText?: (text: string, maxChars: number) => string[];
}

function defaultChunkText(text: string, max: number): string[] {
  if (text.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

/** Create a queue session */
export function createQueueSession(opts: QueueSessionOptions): QueueSession {
  if (opts.mergeOnFlush) {
    return createMergeOnFlushSession(opts);
  }
  switch (opts.strategy) {
    case "immediate":
      return createImmediateSession(opts);
    case "merge-text":
      return createMergeTextSession(opts);
    default:
      return createImmediateSession(opts);
  }
}

/**
 * immediate strategy: send each message directly, no buffering.
 */
function createImmediateSession(opts: QueueSessionOptions): QueueSession {
  const { sender, onComplete } = opts;
  const log = createLog("outbound-queue");
  let aborted = false;
  let sendChain: Promise<void> = Promise.resolve();
  let hasSentContent = false;

  return {
    strategy: "immediate",

    push(item) {
      if (aborted) {
        return Promise.resolve();
      }

      sendChain = sendChain.then(async () => {
        if (aborted) {
          return;
        }
        const result = await sender.send(item);
        if (!result.ok) {
          log.error(`immediate send failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      });

      return sendChain;
    },

    async flush() {
      await sendChain;
      onComplete();
      return hasSentContent;
    },

    abort() {
      aborted = true;
      onComplete();
    },

    drainNow() {
      // immediate strategy sends each message directly, no buffer, no extra action needed
      return sendChain;
    },
  };
}

/**
 * mergeOnFlush mode: push only buffers, flush merges all text into a single message.
 *
 * Used for disableBlockStreaming=true scenarios to avoid sending multi-segment replies.
 */
function createMergeOnFlushSession(opts: QueueSessionOptions): QueueSession {
  const { sender, onComplete } = opts;
  const log = createLog("outbound-queue");
  let aborted = false;
  const textBuf: string[] = [];
  const mediaBuf: OutboundItem[] = [];
  let hasSentContent = false;

  return {
    strategy: "mergeOnFlush",

    push(item) {
      if (aborted) {
        return Promise.resolve();
      }
      if (item.type === "text") {
        if (item.text.trim()) {
          textBuf.push(item.text);
        }
      } else {
        mediaBuf.push(item);
      }
      return Promise.resolve();
    },

    async flush() {
      if (aborted) {
        return hasSentContent;
      }

      // Merge all text into a single message
      if (textBuf.length > 0) {
        const merged = mdFence.stripOuter(textBuf.join("")).trim();
        textBuf.length = 0;
        if (merged) {
          const result = await sender.sendText(merged);
          if (!result.ok) {
            log.error(`mergeOnFlush send merged text failed: ${result.error}`);
          } else {
            hasSentContent = true;
          }
        }
      }

      // Send media/stickers one by one
      for (const item of mediaBuf) {
        if (aborted) {
          break;
        }
        const result = await sender.send(item);
        if (!result.ok) {
          log.error(`mergeOnFlush send media failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      }
      mediaBuf.length = 0;

      onComplete();
      return hasSentContent;
    },

    abort() {
      aborted = true;
      textBuf.length = 0;
      mediaBuf.length = 0;
      onComplete();
    },

    drainNow() {
      // mergeOnFlush strategy sends nothing before flush, drainNow is a no-op
      return Promise.resolve();
    },
  };
}

/**
 * merge-text strategy (default):
 * - On each deliver arrival, immediately process: concatenate then use chunkText (chunkMarkdownText)
 *   for fence-aware splitting; chunks exceeding maxChars send the first n-1 immediately,
 *   the last chunk (possibly inside a fence) stays in buffer for next push or flush
 * - On media, flush text buffer first then send media, preserving order
 * - Accumulation and idle timeout managed by OpenClaw streaming.blockStreamingCoalesceDefaults,
 *   this layer no longer maintains extra idleTimer
 */
function createMergeTextSession(opts: QueueSessionOptions): QueueSession {
  const { sender, onComplete, sessionKey = "" } = opts;
  const minChars = opts.minChars ?? 2800;
  const maxChars = opts.maxChars ?? 3000;
  const baseChunkText = opts.chunkText ?? defaultChunkText;
  // Layer atomic block awareness on top of fence-aware splitting: ensures table and chart fence blocks are not split across messages
  const chunkText = (text: string, max: number) => mdAtomic.chunkAware(text, max, baseChunkText);
  const log = createLog("outbound-queue");
  let aborted = false;
  let textBuffer = "";
  let sendChain: Promise<void> = Promise.resolve();
  let hasSentContent = false;

  /**
   * Split buffer content and send.
   *
   * - `force=true`: split at maxChars limit and send all content, clearing buffer.
   * - `force=false`: fence-aware split at maxChars; if multiple chunks, send first n-1,
   *   keep last chunk in buffer; if only 1 chunk and fence unclosed, defer sending.
   */
  async function drainBuffer(force: boolean): Promise<void> {
    if (textBuffer.length === 0) {
      return;
    }

    const chunks = chunkText(textBuffer, maxChars);
    log.debug(
      `[${sessionKey}] drainBuffer force=${force}: inputLen=${textBuffer.length}, chunks=${chunks.length}`,
    );

    if (force || chunks.length <= 1) {
      // Non-forced single chunk: defer if fence is unclosed
      if (!force && chunks.length === 1 && mdFence.hasUnclosed(chunks[0])) {
        log.debug(
          `[${sessionKey}] drainBuffer: single chunk has unclosed fence, keeping in buffer`,
        );
        return;
      }
      // Non-forced single chunk: defer if ends with table row
      if (!force && chunks.length === 1 && mdBlock.endsWithTableRow(chunks[0])) {
        log.debug(
          `[${sessionKey}] drainBuffer: single chunk ends with table row, keeping in buffer`,
        );
        return;
      }
      // Non-forced single chunk: defer if below minChars threshold
      if (!force && chunks.length === 1 && textBuffer.length < minChars) {
        log.debug(
          `[${sessionKey}] drainBuffer: bufLen=${textBuffer.length} < minChars=${minChars}, waiting`,
        );
        return;
      }
      textBuffer = "";
      for (const chunk of chunks) {
        if (aborted) {
          return;
        }
        if (!chunk.trim()) {
          continue;
        }
        const result = await sender.sendText(chunk);
        if (!result.ok) {
          log.error(`[${sessionKey}] send failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      }
    } else {
      // Send first n-1 chunks (fence-safe boundary), keep last chunk in buffer
      const toSend = chunks.slice(0, -1);
      textBuffer = chunks[chunks.length - 1]!;
      log.debug(
        `[${sessionKey}] drainBuffer: sending ${toSend.length} chunk(s), remainder len=${textBuffer.length}`,
      );
      for (const chunk of toSend) {
        if (aborted) {
          return;
        }
        if (!chunk.trim()) {
          continue;
        }
        const result = await sender.sendText(chunk);
        if (!result.ok) {
          log.error(`[${sessionKey}] merge-text send failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      }
    }
  }

  return {
    strategy: "merge-text",

    push(item) {
      if (aborted) {
        return Promise.resolve();
      }

      sendChain = sendChain.then(async () => {
        if (aborted) {
          return;
        }

        if (item.type === "text") {
          if (!item.text.trim()) {
            return;
          }
          if (textBuffer) {
            // block-streaming's trimEnd/trimStart strips newlines at each block boundary;
            // need to infer and restore the correct separator based on context:
            //  - block-level element start (heading/hr/blockquote/list/fence) → add \n\n
            //  - consecutive table rows split → add \n (table rows can't have blank lines between)
            //  - inside fence / already has newline / plain text continuation → don't add
            const separator = mdBlock.inferSeparator(textBuffer, item.text);
            textBuffer = mdFence.mergeBlockStreaming(
              separator ? `${textBuffer}${separator}` : textBuffer,
              item.text,
            );
          } else {
            textBuffer = item.text;
          }
          log.debug(`[${sessionKey}] merge-text push: bufLen=${textBuffer.length}`);
          hasSentContent = true;
          await drainBuffer(false);
        } else {
          // On media/sticker: force flush buffered text first, then send
          if (textBuffer.length > 0) {
            log.debug(`[${sessionKey}] merge-text media push: flushing text buffer first`);
            await drainBuffer(true);
          }
          if (aborted) {
            return;
          }
          const result = await sender.send(item);
          if (!result.ok) {
            log.error(`[${sessionKey}] merge-text send media failed: ${result.error}`);
          } else {
            hasSentContent = true;
          }
        }
      });

      return sendChain;
    },

    async flush() {
      log.debug(`[${sessionKey}] merge-text session flush: bufLen=${textBuffer.length}`);
      await sendChain;
      if (aborted) {
        return hasSentContent;
      }
      textBuffer = mdFence.stripOuter(textBuffer);
      await drainBuffer(true);
      onComplete();
      return hasSentContent;
    },

    abort() {
      const bufLen = textBuffer.length;
      log.info(`[${sessionKey}] merge-text session aborted, discarding bufLen=${bufLen}`);
      aborted = true;
      textBuffer = "";
      onComplete();
    },

    drainNow() {
      if (aborted || !textBuffer) {
        return Promise.resolve();
      }
      // Force send current textBuffer content immediately without closing session.
      // Chained on sendChain to ensure serial execution with in-progress push().
      sendChain = sendChain.then(async () => {
        if (aborted || !textBuffer) {
          return;
        }
        log.debug(
          `[${sessionKey}] drainNow: force flushing bufLen=${textBuffer.length} before tool call`,
        );
        await drainBuffer(true);
      });
      return sendChain;
    },
  };
}

/**
 * merge-text strategy session factory, exported only for unit testing.
 * @internal
 */
export { createMergeTextSession as createMergeTextSessionForTest };
