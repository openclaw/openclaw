// Media Core tests cover read byte stream with limit behavior.
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readByteStreamWithLimit } from "./read-byte-stream-with-limit.js";

describe("readByteStreamWithLimit", () => {
  it("returns concatenated bytes up to the limit", async () => {
    const buffer = await readByteStreamWithLimit(Readable.from([Buffer.from("ab"), "cd"]), {
      maxBytes: 4,
    });

    expect(buffer).toEqual(Buffer.from("abcd"));
  });

  it("throws and destroys node streams after overflow", async () => {
    const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(4)]);
    const destroySpy = vi.spyOn(stream, "destroy");
    const errorSpy = vi.fn();
    stream.on("error", errorSpy);

    await expect(
      readByteStreamWithLimit(stream, {
        maxBytes: 7,
        onOverflow: ({ size, maxBytes }) => new Error(`too large ${size}/${maxBytes}`),
      }),
    ).rejects.toThrow("too large 8/7");
    expect(destroySpy).toHaveBeenCalledWith();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("rejects immediately with AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      readByteStreamWithLimit(Readable.from([Buffer.from("ab")]), {
        maxBytes: 4,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("destroys the stream and rejects with AbortError when the signal aborts mid-read", async () => {
    const controller = new AbortController();
    const stream = new Readable({
      read() {
        // Hold the stream open until the signal aborts it; this mimics a
        // held-open stdin waiting for EOF after Ctrl-C.
      },
    });
    const destroySpy = vi.spyOn(stream, "destroy");

    const reading = readByteStreamWithLimit(stream, {
      maxBytes: 4,
      signal: controller.signal,
    });

    controller.abort();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(destroySpy).toHaveBeenCalled();
  });

  it("reads a WHATWG ReadableStream through an owned reader", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61]));
        controller.enqueue(new Uint8Array([0x62]));
        controller.close();
      },
    });

    const buffer = await readByteStreamWithLimit(stream, { maxBytes: 4 });
    expect(buffer).toEqual(Buffer.from("ab"));
  });

  it("cancels the owned reader and rejects with AbortError when a WHATWG ReadableStream stalls", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream({
      start() {
        // Never enqueue or close; mimics a stalled HTTP response body held open
        // by the network while the operator cancels the command.
      },
    });

    const reading = readByteStreamWithLimit(stream, {
      maxBytes: 1024,
      signal: controller.signal,
    });

    controller.abort();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws and cancels the owned reader after a WHATWG ReadableStream overflow", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61]));
        controller.enqueue(new Uint8Array([0x62]));
        controller.close();
      },
    });

    await expect(
      readByteStreamWithLimit(stream, {
        maxBytes: 1,
        onOverflow: ({ size, maxBytes }) => new Error(`too large ${size}/${maxBytes}`),
      }),
    ).rejects.toThrow("too large 2/1");
  });
});
