// Codex tests cover bounded JSONL window reads.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonlHead, readJsonlTail } from "./jsonl-lines.js";

let tempDir: string;
let counter = 0;

/**
 * `readSessionFileSummary` concatenates a head and a tail window and reports the result as exact
 * when `tail.start <= head.endOffset`. Every record must therefore appear in exactly one window,
 * and that claim of exactness must never hold across a gap — so pin the offsets directly here
 * rather than only through the listing command.
 */
describe("bounded JSONL windows", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-jsonl-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reports a whole small file as complete and ends the window at its size", async () => {
    const file = await write("a\nb\n");

    await expect(readJsonlHead(file, 1_024)).resolves.toEqual({
      lines: ["a", "b"],
      complete: true,
      endOffset: 4,
      bytesRead: 4,
    });
  });

  it("keeps a final line that has no trailing newline", async () => {
    const file = await write("a\nb");

    await expect(readJsonlHead(file, 1_024)).resolves.toEqual({
      lines: ["a", "b"],
      complete: true,
      endOffset: 3,
      bytesRead: 3,
    });
  });

  it("strips carriage returns from CRLF records", async () => {
    const file = await write("a\r\nb\r\n");

    await expect(readJsonlHead(file, 1_024)).resolves.toEqual({
      lines: ["a", "b"],
      complete: true,
      endOffset: 6,
      bytesRead: 6,
    });
  });

  it("treats an empty file as complete with no records", async () => {
    const file = await write("");

    await expect(readJsonlHead(file, 1_024)).resolves.toEqual({
      lines: [],
      complete: true,
      endOffset: 0,
      bytesRead: 0,
    });
    await expect(readJsonlTail(file, 1_024)).resolves.toEqual({
      lines: [],
      start: 0,
      bytesRead: 0,
    });
  });

  it("ends a truncated head window on the last record boundary", async () => {
    const file = await write("aaaa\nbbbbbbbbb\n");

    await expect(readJsonlHead(file, 8)).resolves.toEqual({
      lines: ["aaaa"],
      complete: false,
      endOffset: 5,
      bytesRead: 8,
    });
  });

  it("returns no record when the first one is wider than the head window", async () => {
    const file = await write(`${"x".repeat(99)}\n`);

    await expect(readJsonlHead(file, 10)).resolves.toEqual({
      lines: [],
      complete: false,
      endOffset: 0,
      bytesRead: 10,
    });
  });

  it("drops the partial record a tail window opens inside", async () => {
    const file = await write("aaaa\nbbbb\ncccc\n");

    await expect(readJsonlTail(file, 8)).resolves.toEqual({
      lines: ["cccc"],
      start: 10,
      bytesRead: 8,
    });
  });

  it("returns no record when the tail window opens inside one oversized record", async () => {
    const file = await write(`short\n${"y".repeat(99)}`);

    await expect(readJsonlTail(file, 10)).resolves.toEqual({
      lines: [],
      start: 105,
      bytesRead: 10,
    });
  });

  it("returns no record when the tail window holds only a closing newline", async () => {
    const file = await write(`short\n${"y".repeat(99)}\n`);

    await expect(readJsonlTail(file, 10)).resolves.toEqual({
      lines: [],
      start: 106,
      bytesRead: 10,
    });
  });

  it("resumes a tail exactly where the head stopped, with no record on both sides", async () => {
    const file = await write("aaaa\nbbbb\ncccc\ndddd\n");
    const head = await readJsonlHead(file, 12);
    const tail = await readJsonlTail(file, 10, { notBefore: head?.endOffset });

    expect(head).toEqual({
      lines: ["aaaa", "bbbb"],
      complete: false,
      endOffset: 10,
      bytesRead: 12,
    });
    // Without the floor this window would start at byte 10 anyway; the floor is what keeps a wider
    // window from reaching back into the head and returning "bbbb" a second time.
    expect(tail).toEqual({ lines: ["cccc", "dddd"], start: 10, bytesRead: 10 });
    await expect(readJsonlTail(file, 1_024, { notBefore: head?.endOffset })).resolves.toEqual({
      lines: ["cccc", "dddd"],
      start: 10,
      bytesRead: 10,
    });
    expect(tail?.start).toBeLessThanOrEqual(head?.endOffset ?? -1);
  });

  it("never claims coverage across a gap between the windows", async () => {
    const file = await write(`aaaa\n${"m".repeat(200)}\ndddd\n`);
    const head = await readJsonlHead(file, 12);
    const tail = await readJsonlTail(file, 8, { notBefore: head?.endOffset });

    expect(head?.endOffset).toBe(5);
    // The middle record was never read, so the tail must not abut the head.
    expect(tail?.lines).toEqual(["dddd"]);
    expect(tail?.start).toBeGreaterThan(head?.endOffset ?? 0);
  });

  it("clamps a floor at or past the end of the file instead of re-reading it", async () => {
    const file = await write("aaaa\nbbbb\n");

    await expect(readJsonlTail(file, 8, { notBefore: 10 })).resolves.toEqual({
      lines: [],
      start: 10,
      bytesRead: 0,
    });
    await expect(readJsonlTail(file, 8, { notBefore: 9_999 })).resolves.toEqual({
      lines: [],
      start: 10,
      bytesRead: 0,
    });
  });

  it("ignores a negative floor", async () => {
    const file = await write("aaaa\nbbbb\n");

    await expect(readJsonlTail(file, 1_024, { notBefore: -5 })).resolves.toEqual({
      lines: ["aaaa", "bbbb"],
      start: 0,
      bytesRead: 10,
    });
  });

  it("keeps multi-byte characters intact at every window boundary", async () => {
    const record = `{"t":"€uro"}`;
    const file = await write(`${record}\n${record}\n${record}\n`);
    const size = (await fs.stat(file)).size;

    for (let bytes = 1; bytes <= size; bytes += 1) {
      const head = await readJsonlHead(file, bytes);
      const tail = await readJsonlTail(file, bytes);
      for (const line of [...(head?.lines ?? []), ...(tail?.lines ?? [])]) {
        expect(line).not.toContain("\ufffd");
      }
    }
  });

  it("reports a missing file rather than throwing", async () => {
    const missing = path.join(tempDir, "absent.jsonl");

    await expect(readJsonlHead(missing, 1_024)).resolves.toBeNull();
    await expect(readJsonlTail(missing, 1_024)).resolves.toBeNull();
  });

  async function write(content: string): Promise<string> {
    counter += 1;
    const file = path.join(tempDir, `window-${String(counter)}.jsonl`);
    await fs.writeFile(file, content);
    return file;
  }
});
