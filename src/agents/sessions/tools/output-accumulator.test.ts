// OutputAccumulator tests cover bounded UTF-8 tails and private spill files.
import { readFile, rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createWindowsOutputDecoder } from "../../../infra/windows-encoding.js";
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

  it("flushes pending bytes held by every stream lane", () => {
    // Each lane decodes independently, so a truncated character left on one
    // pipe must not stop the other pipe's tail from being flushed.
    const accumulator = new OutputAccumulator();

    accumulator.append(Buffer.from([0xe6, 0x97]), "stdout"); // leading bytes of 日
    accumulator.append(Buffer.from([0xe6, 0x97]), "stderr");

    const flushed = accumulator.finish();

    expect(flushed).toBe("��");
  });

  it("decodes Windows console code page output for session bash streams", () => {
    const accumulator = new OutputAccumulator({
      createTextDecoder: () =>
        createWindowsOutputDecoder({ platform: "win32", windowsEncoding: "gbk" }),
    });
    const cp936DirHeader = Buffer.from([
      199, 253, 182, 175, 198, 247, 32, 67, 32, 214, 208, 181, 196, 190, 237, 202, 199, 32, 65, 99,
      101, 114,
    ]);

    const text = accumulator.append(cp936DirHeader, "stdout") + accumulator.finish();

    expect(text).toBe("驱动器 C 中的卷是 Acer");
    expect(accumulator.snapshot().content).toBe("驱动器 C 中的卷是 Acer");
  });

  it("spills tagged streams in decoded delivery order", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 1,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    accumulator.append(Buffer.from([0xe6, 0x97]), "stdout"); // leading bytes of 日
    accumulator.append(Buffer.from("E"), "stderr");
    accumulator.append(Buffer.from([0xa5]), "stdout");
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();

    expect(snapshot.fullOutputPath).toBeDefined();
    expect(await readFile(snapshot.fullOutputPath!, "utf8")).toBe("E日");
    await rm(snapshot.fullOutputPath!, { force: true });
  });

  it("spills decoded text for truncated untagged custom-decoder output", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 1,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
      createTextDecoder: () =>
        createWindowsOutputDecoder({ platform: "win32", windowsEncoding: "gbk" }),
    });
    const cp936Text = "\u9a71\u52a8\u5668 C \u4e2d\u7684\u5377\u662f Acer";
    const cp936Bytes = Buffer.from([
      199, 253, 182, 175, 198, 247, 32, 67, 32, 214, 208, 181, 196, 190, 237, 202, 199, 32, 65, 99,
      101, 114,
    ]);

    accumulator.append(cp936Bytes);
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();

    expect(snapshot.truncation.truncated).toBe(true);
    expect(await readFile(snapshot.fullOutputPath!, "utf8")).toBe(cp936Text);
    await rm(snapshot.fullOutputPath!, { force: true });
  });
});
