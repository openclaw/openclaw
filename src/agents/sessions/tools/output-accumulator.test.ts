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

  it("flushes stateful transforms on finish", async () => {
    let pending = "";
    const accumulator = new OutputAccumulator({
      maxBytes: 100,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
      transformDecodedText: {
        write: (text) => {
          const combined = pending + text;
          if (combined.endsWith("<")) {
            pending = "<";
            return combined.slice(0, -1);
          }
          pending = "";
          return combined;
        },
        finish: () => {
          const text = pending;
          pending = "";
          return text ? "[pending]" : "";
        },
      },
    });

    expect(accumulator.append(Buffer.from("hello<"))).toBe("hello");
    expect(accumulator.finish()).toBe("[pending]");

    expect(accumulator.snapshot().content).toBe("hello[pending]");
  });
});
