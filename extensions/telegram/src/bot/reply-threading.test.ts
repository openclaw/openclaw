// Telegram tests cover single-use reply consumption when chunks silently skip.
import { describe, expect, it, vi } from "vitest";
import { type DeliveryProgress, sendChunkedTelegramReplyText } from "./reply-threading.js";

function createProgress(): DeliveryProgress {
  return { hasReplied: false, hasDelivered: false };
}

describe("sendChunkedTelegramReplyText single-use reply consumption", () => {
  it("consumes the suppressed reply target on the first delivered chunk, not chunk 0", async () => {
    const progress = createProgress();
    const hasRepliedAtEntry: boolean[] = [];
    const seenReplyTargets: Array<number | undefined> = [];
    // Chunk 0 silently skips (empty Telegram payload); chunks 1-2 deliver.
    const results: Array<number | undefined> = [undefined, 101, 102];
    const sendChunk = vi.fn(async (opts: { replyToMessageId?: number }) => {
      hasRepliedAtEntry.push(progress.hasReplied);
      seenReplyTargets.push(opts.replyToMessageId);
      return results[sendChunk.mock.calls.length - 1];
    });

    await sendChunkedTelegramReplyText({
      chunks: ["skips", "delivers", "delivers too"],
      progress,
      replyToId: 555,
      replyToMode: "first",
      sendChunk,
    });

    // Suppressed multi-chunk mode attaches the native reply target to no chunk.
    expect(seenReplyTargets).toEqual([undefined, undefined, undefined]);
    // Consumption happens on the first delivered chunk: still unconsumed when
    // the skipped chunk and the first delivered chunk are sent, consumed after.
    expect(hasRepliedAtEntry).toEqual([false, false, true]);
    expect(progress.hasReplied).toBe(true);

    // A later send sharing the progress must not reuse the consumed target.
    const followUpTargets: Array<number | undefined> = [];
    await sendChunkedTelegramReplyText({
      chunks: ["follow-up"],
      progress,
      replyToId: 555,
      replyToMode: "first",
      sendChunk: async (opts) => {
        followUpTargets.push(opts.replyToMessageId);
        return 103;
      },
    });
    expect(followUpTargets).toEqual([undefined]);
  });

  it("attaches the reply target to the first delivered single-chunk send exactly once", async () => {
    const progress = createProgress();
    const seenReplyTargets: Array<number | undefined> = [];
    const results: Array<number | undefined> = [undefined, 201, 202];
    const sendChunk = vi.fn(async (opts: { replyToMessageId?: number }) => {
      seenReplyTargets.push(opts.replyToMessageId);
      return results[sendChunk.mock.calls.length - 1];
    });

    // Three separate single-chunk batches share one progress: skipped batches
    // neither consume nor break the reply chain, and the target attaches once.
    for (const text of ["skips", "delivers", "delivers too"]) {
      await sendChunkedTelegramReplyText({
        chunks: [text],
        progress,
        replyToId: 555,
        replyToMode: "first",
        sendChunk,
      });
    }

    expect(seenReplyTargets).toEqual([555, 555, undefined]);
    expect(progress.hasReplied).toBe(true);
  });

  it("carries one-time reply buttons to the first delivered chunk when chunk 0 skips", async () => {
    const progress = createProgress();
    const seenMarkup: Array<unknown> = [];
    // Chunk 0 renders empty and is skipped (undefined); chunk 1 delivers.
    const results: Array<number | undefined> = [undefined, 301];
    const replyMarkup = { inline_keyboard: [] };
    const sendChunk = vi.fn(async (opts: { replyMarkup?: unknown }) => {
      seenMarkup.push(opts.replyMarkup);
      return results[sendChunk.mock.calls.length - 1];
    });

    await sendChunkedTelegramReplyText({
      chunks: ["skips", "delivers"],
      progress,
      replyToId: 555,
      replyToMode: "all",
      replyMarkup,
      sendChunk,
    });

    // The skipped chunk 0 does not consume the one-time buttons; they carry
    // forward so the actually-delivered chunk 1 still receives them.
    expect(seenMarkup).toEqual([replyMarkup, replyMarkup]);
  });

  it("carries the first-only quote to the first delivered chunk when chunk 0 skips", async () => {
    const progress = createProgress();
    const seenQuotes: Array<string | undefined> = [];
    const results: Array<number | undefined> = [undefined, 401];
    const sendChunk = vi.fn(async (opts: { replyQuoteText?: string }) => {
      seenQuotes.push(opts.replyQuoteText);
      return results[sendChunk.mock.calls.length - 1];
    });

    await sendChunkedTelegramReplyText({
      chunks: ["skips", "delivers"],
      progress,
      replyToId: 555,
      replyToMode: "all",
      replyQuoteText: "quoted",
      quoteOnlyOnFirstChunk: true,
      sendChunk,
    });

    // First-only quote must land on the first DELIVERED chunk (index 1), not be
    // consumed by the skipped chunk 0.
    expect(seenQuotes[seenQuotes.length - 1]).toBe("quoted");
  });
});
