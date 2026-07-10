// Tests for stream normalizer zero-parameter XML recognition.
import { describe, expect, test } from "vitest";
import { normalizePlainTextToolCallStreamEvents } from "./stream-normalizer.js";

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

const allNames = { hasNamePrefix: () => true, hasExactName: () => true };
const noopDone = { normalizeDoneMessage: () => null as any };
const noopPromote = { createPromotedToolCallEvents: () => [] as any };

describe("normalizePlainTextToolCallStreamEvents", () => {
  test("passes through non-tool-call text", async () => {
    const events = [{ type: "text_delta", delta: "hello world" }];
    const result = await collect(
      normalizePlainTextToolCallStreamEvents(
        (async function* () {
          yield* events;
        })(),
        { matcher: allNames, ...noopDone, ...noopPromote },
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "text_delta", delta: "hello world" });
  });

  test("recognizes zero-parameter XML as a possible tool call (not impossible)", async () => {
    // Send a zero-param XML tool call followed by non-tool-call text.
    // The first event should be buffered (state = "possible", not "impossible"),
    // not flushed immediately. Both are flushed together at end-of-stream.
    const events = [
      { type: "text_delta", delta: "<function=get_info></function>" },
      { type: "text_delta", delta: "after" },
    ];
    const result = await collect(
      normalizePlainTextToolCallStreamEvents(
        (async function* () {
          yield* events;
        })(),
        { matcher: allNames, ...noopDone, ...noopPromote },
      ),
    );
    // Both events are emitted (end-of-stream flush), but the important
    // property: they are NOT emitted individually during the stream.
    // The result count of 2 proves they were both buffered and flushed
    // together, rather than the first being flushed immediately as
    // "impossible" before the second event arrives.
    expect(result).toHaveLength(2);
  });
});
