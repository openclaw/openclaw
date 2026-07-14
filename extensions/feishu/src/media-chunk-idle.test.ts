// Feishu tests cover inbound media chunk-idle timeout helpers.
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveMediaStreamMock = vi.hoisted(() =>
  vi.fn(async (stream: AsyncIterable<unknown>) => {
    let size = 0;
    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) {
        size += chunk.byteLength;
      }
    }
    return { id: "saved", path: "/tmp/saved", size, contentType: "image/jpeg" };
  }),
);

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream: saveMediaStreamMock,
}));

describe("saveMediaStreamWithIdleTimeout", () => {
  let saveMediaStreamWithIdleTimeout: typeof import("./media-chunk-idle.js").saveMediaStreamWithIdleTimeout;
  const FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS = 30_000;

  beforeEach(async () => {
    vi.resetModules();
    saveMediaStreamMock.mockClear();
    ({ saveMediaStreamWithIdleTimeout } = await import("./media-chunk-idle.js"));
  });

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

  it("negative control: never-yielding stream without idle wrap stays pending", async () => {
    // Pre-fix shape: saveMediaStream's unbounded `for await` on a stalled
    // Lark body never settles. Prove the hang before asserting the wrap.
    const consume = (async () => {
      // Hang on the first stalled `next()` — same unbounded wait as bare `for await`.
      await neverYieldingStream()[Symbol.asyncIterator]().next();
    })();
    const outcome = await Promise.race([
      consume.then(() => "resolved" as const),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 150);
      }),
    ]);
    expect(outcome).toBe("still-pending");
    console.log(
      `[feishu media idle negative control] outcome=${outcome} wait_ms=150 without_idle_wrap=true`,
    );
  });

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
    const promise = saveMediaStreamWithIdleTimeout(
      neverYieldingStream(),
      "image/jpeg",
      1024,
      undefined,
      50,
    );
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
    const result = await saveMediaStreamWithIdleTimeout(
      delayedStream(jpeg, 10),
      "image/jpeg",
      1024,
      undefined,
      500,
    );
    expect(result.size).toBe(jpeg.byteLength);
  });

  it("defaults to a 30s production idle floor", async () => {
    vi.useFakeTimers();
    const promise = saveMediaStreamWithIdleTimeout(neverYieldingStream(), "image/jpeg", 1024);
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
      saveMediaStreamWithIdleTimeout(stream, "image/jpeg", 1024, undefined, 50),
    ).rejects.toMatchObject({ name: "FeishuInboundMediaTimeoutError" });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it("completes a progressing Node.js Readable without triggering timeout", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const readable = Readable.from([jpeg]);

    const result = await saveMediaStreamWithIdleTimeout(
      readable,
      "image/jpeg",
      1024,
      undefined,
      50,
    );
    expect(result.size).toBe(jpeg.byteLength);
  });

  it("rejects a stalled Node.js Readable on timeout without hanging (Lark SDK boundary)", async () => {
    const stalledReadable = new Readable({
      read() {
        // Never push data — simulates stalled Lark HTTP response body.
      },
    });

    const startedAt = Date.now();
    await expect(
      saveMediaStreamWithIdleTimeout(stalledReadable, "image/jpeg", 1024, undefined, 50),
    ).rejects.toMatchObject({ name: "FeishuInboundMediaTimeoutError" });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[feishu media idle proof] boundary=Readable timed_out=true elapsed_ms=${elapsedMs}`,
    );
  });
});
