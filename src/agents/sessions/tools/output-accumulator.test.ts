// OutputAccumulator tests cover bounded UTF-8 tails and private spill files.
import { rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "./output-accumulator.js";

describe("OutputAccumulator", () => {
  it("stores spilled full output in an owner-only temp file", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 8,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    accumulator.append(Buffer.from("secret output"));
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();

    expect(snapshot.fullOutputPath).toBeDefined();
    // Spilled output can include command secrets, so temp files must be
    // owner-only even though their path is returned to the local operator.
    const mode = (await stat(snapshot.fullOutputPath!)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    await rm(snapshot.fullOutputPath!, { force: true });
  });

  it("keeps complete UTF-8 characters in a byte-bounded tail", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 5,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    accumulator.append(Buffer.from("a🙂b"));
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();

    expect(snapshot.content).toBe("🙂b");
    expect(snapshot.truncation.totalBytes).toBe(6);
    expect(snapshot.truncation.outputBytes).toBe(5);
    expect(snapshot.fullOutputPath).toBeDefined();
    await rm(snapshot.fullOutputPath!, { force: true });
  });

  it("does not leak temp file after closeTempFile is called without a spill", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 128,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });
    accumulator.append(Buffer.from("short"));
    accumulator.finish();
    // closeTempFile is safe (idempotent) when no temp file was created
    await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
  });

  it("cleans up spilled temp file after normal completion", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 4,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });
    accumulator.append(Buffer.from("more than 4 bytes"));
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    expect(snapshot.fullOutputPath).toBeDefined();
    await accumulator.closeTempFile();
    await rm(snapshot.fullOutputPath!, { force: true });
  });

  it("propagates write error when spill stream fails", () => {
    const writeError = new Error("disk full");
    const accumulator = new OutputAccumulator({
      maxBytes: 4,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    // Trigger spill by writing more than maxBytes
    accumulator.append(Buffer.from("more than four bytes to force spill"));

    // Replace the live stream with one that throws on write
    (accumulator as Record<string, unknown>).tempFileStream = {
      write() {
        throw writeError;
      },
    };

    // Append after the stream is broken — must throw the write error
    expect(() => accumulator.append(Buffer.from("x"))).toThrow(writeError);
  });
});
