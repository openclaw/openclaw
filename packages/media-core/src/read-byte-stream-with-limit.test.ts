// Media Core tests cover read byte stream with limit behavior.
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it.each(["Buffer", "Uint8Array", "DataView", "ArrayBuffer"])(
    "retains file bytes when the producer reuses a %s chunk",
    async (chunkType) => {
      const directory = await mkdtemp(join(tmpdir(), "openclaw-byte-stream-"));
      try {
        const filename = join(directory, "payload.bin");
        await writeFile(filename, "abcd");
        const expected = await readFile(filename);
        async function* chunks() {
          const handle = await open(filename, "r");
          const scratch =
            chunkType === "ArrayBuffer"
              ? Buffer.from(new ArrayBuffer(2))
              : Buffer.from(new ArrayBuffer(4), 1, 2);
          try {
            while ((await handle.read(scratch)).bytesRead > 0) {
              switch (chunkType) {
                case "ArrayBuffer":
                  yield scratch.buffer;
                  break;
                case "Uint8Array":
                  yield new Uint8Array(scratch.buffer, scratch.byteOffset, scratch.byteLength);
                  break;
                case "DataView":
                  yield new DataView(scratch.buffer, scratch.byteOffset, scratch.byteLength);
                  break;
                default:
                  yield scratch;
              }
            }
          } finally {
            await handle.close();
          }
        }
        expect(await readByteStreamWithLimit(chunks(), { maxBytes: expected.length })).toEqual(
          expected,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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
});
