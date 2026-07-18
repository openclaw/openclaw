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

  it("detects invalid UTF-8 bytes in append() and switches to permissive fallback", () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 128,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    // Valid prefix then invalid byte 0xFF mid-stream
    accumulator.append(Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f])); // "Hello"
    expect(accumulator.hasBinaryData()).toBe(false);

    accumulator.append(Buffer.from([0xff, 0x21])); // 0xFF is invalid UTF-8, 0x21 is '!'
    expect(accumulator.hasBinaryData()).toBe(true);

    accumulator.finish();
    const snapshot = accumulator.snapshot();
    // The fallback decoder produces U+FFFD for 0xFF, which is the best-effort
    // representation; the key is that binaryDetected is true so callers can flag it.
    expect(snapshot.content).toContain("!");
  });

  it("detects invalid UTF-8 bytes in finish() final flush", () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 128,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    // Incomplete multi-byte sequence: 0xC3 alone expects a continuation byte
    accumulator.append(Buffer.from([0x48, 0x69, 0xc3]));
    expect(accumulator.hasBinaryData()).toBe(false);

    accumulator.finish();
    // The strict decoder in finish() should detect the truncated sequence
    expect(accumulator.hasBinaryData()).toBe(true);
  });
});
