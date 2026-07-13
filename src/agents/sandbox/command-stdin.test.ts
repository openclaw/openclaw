import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createChunkedCommandInput } from "../../process/exec.js";

describe("createChunkedCommandInput", () => {
  it("streams large buffers in bounded chunks without changing their bytes", async () => {
    const input = Buffer.alloc(2 * 64 * 1024 + 17);
    input.forEach((_, index) => {
      input[index] = index % 251;
    });
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });

    const commandInput = createChunkedCommandInput(input);
    if (!(commandInput instanceof Readable)) {
      throw new Error("expected a stream for large command input");
    }
    await pipeline(commandInput, stdin);

    expect(chunks.map((chunk) => chunk.length)).toEqual([64 * 1024, 64 * 1024, 17]);
    expect(Buffer.concat(chunks)).toEqual(input);
  });
});
