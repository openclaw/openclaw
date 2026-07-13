// Feishu tests cover inbound media chunk-idle timeout helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS, withChunkIdleTimeout } from "./media-chunk-idle.js";

describe("withChunkIdleTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function neverYieldingStream(): AsyncIterable<Buffer> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Buffer>> {
            return new Promise<IteratorResult<Buffer>>(() => {});
          },
        };
      },
    };
  }

  function delayedStream(payload: Buffer, delayMs: number): AsyncIterable<Buffer> {
    let yielded = false;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Buffer>> {
            if (yielded) {
              return { value: undefined as unknown as Buffer, done: true };
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, delayMs);
            });
            yielded = true;
            return { value: payload, done: false };
          },
        };
      },
    };
  }

  it("rejects when the source stalls past chunkTimeoutMs", async () => {
    const startedAt = Date.now();
    const promise = (async () => {
      for await (const _chunk of withChunkIdleTimeout(neverYieldingStream(), 50)) {
        void _chunk;
      }
    })();
    await expect(promise).rejects.toMatchObject({
      name: "FeishuInboundMediaTimeoutError",
      chunkTimeoutMs: 50,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[feishu media idle proof] timed_out=true elapsed_ms=${elapsedMs} chunkTimeoutMs=50 production_ms=${FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS}`,
    );
  });

  it("does not reject when chunks arrive within chunkTimeoutMs", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const chunks: Buffer[] = [];
    for await (const chunk of withChunkIdleTimeout(delayedStream(jpeg, 10), 500)) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(jpeg);
  });

  it("defaults to a 30s production idle floor", async () => {
    vi.useFakeTimers();
    const promise = (async () => {
      for await (const _chunk of withChunkIdleTimeout(
        neverYieldingStream(),
        FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
      )) {
        void _chunk;
      }
    })();
    const expectation = expect(promise).rejects.toMatchObject({
      name: "FeishuInboundMediaTimeoutError",
      chunkTimeoutMs: FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS - 1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    await expectation;
    console.log(
      `[feishu media idle proof] production_default_ms=${FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS} timed_out=true`,
    );
  });

  it("calls iterator.return() exactly once on timeout so the upstream Readable is destroyed", async () => {
    const returnSpy = vi.fn(async () => ({
      value: undefined as unknown as Buffer,
      done: true,
    }));
    const stream: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Buffer>> {
            return new Promise<IteratorResult<Buffer>>(() => {});
          },
          return: returnSpy as () => Promise<IteratorResult<Buffer>>,
        };
      },
    };
    await expect(
      (async () => {
        for await (const _chunk of withChunkIdleTimeout(stream, 50)) {
          void _chunk;
        }
      })(),
    ).rejects.toMatchObject({ name: "FeishuInboundMediaTimeoutError" });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});
