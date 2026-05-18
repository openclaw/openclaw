import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getQueuedFileWriter, resolveQueuedFileAppendFlags } from "./queued-file-writer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-queued-writer-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("getQueuedFileWriter", () => {
  it("keeps append flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveQueuedFileAppendFlags({
        O_APPEND: 0x01,
        O_CREAT: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });

  it("creates log files with restrictive permissions", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("line\n");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("line\n");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("refuses to append through a symlink", async () => {
    const tmpDir = makeTempDir();
    const targetPath = path.join(tmpDir, "target.txt");
    const filePath = path.join(tmpDir, "trace.jsonl");
    fs.writeFileSync(targetPath, "before\n", "utf8");
    fs.symlinkSync(targetPath, filePath);
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("after\n");
    await writer.flush();

    expect(fs.readFileSync(targetPath, "utf8")).toBe("before\n");
  });

  it("refuses to append through a symlinked parent directory", async () => {
    const tmpDir = makeTempDir();
    const targetDir = path.join(tmpDir, "target");
    const linkDir = path.join(tmpDir, "link");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir);
    const writer = getQueuedFileWriter(new Map(), path.join(linkDir, "trace.jsonl"));

    writer.write("after\n");
    await writer.flush();

    expect(fs.existsSync(path.join(targetDir, "trace.jsonl"))).toBe(false);
  });

  it("stops appending when the configured file cap is reached", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, { maxFileBytes: 6 });

    writer.write("12345\n");
    writer.write("after\n");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("12345\n");
  });

  it("drops writes that would exceed the pending queue cap", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, { maxQueuedBytes: 6 });

    expect(writer.write("12345\n")).toBe("queued");
    expect(writer.write("after\n")).toBe("dropped");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("12345\n");
  });

  it("rotates the active file into .1 when maxFiles is configured", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, {
      maxFileBytes: 6,
      maxFiles: 3,
    });

    writer.write("12345\n");
    writer.write("after\n");
    await writer.flush();

    expect(fs.readFileSync(`${filePath}.1`, "utf8")).toBe("12345\n");
    expect(fs.readFileSync(filePath, "utf8")).toBe("after\n");
    expect(fs.existsSync(`${filePath}.2`)).toBe(false);
  });

  it("shifts older archives up and unlinks the oldest beyond maxFiles", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, {
      maxFileBytes: 6,
      maxFiles: 3,
    });

    // Each line is 6 bytes (matches the cap), so the next 6-byte write forces
    // a rotation. After three rotations the oldest archive must drop.
    writer.write("aaaaa\n"); // active = aaaaa
    writer.write("bbbbb\n"); // rotates aaaaa -> .1; active = bbbbb
    writer.write("ccccc\n"); // rotates: .1 (aaaaa) -> .2, bbbbb -> .1, active = ccccc
    writer.write("ddddd\n"); // rotates: .2 (aaaaa) unlinked, .1 (bbbbb) -> .2,
    //                                   ccccc -> .1, active = ddddd
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("ddddd\n");
    expect(fs.readFileSync(`${filePath}.1`, "utf8")).toBe("ccccc\n");
    expect(fs.readFileSync(`${filePath}.2`, "utf8")).toBe("bbbbb\n");
    expect(fs.existsSync(`${filePath}.3`)).toBe(false);
  });

  it("truncates the active file when maxFiles is 1", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, {
      maxFileBytes: 6,
      maxFiles: 1,
    });

    writer.write("12345\n");
    writer.write("after\n");
    await writer.flush();

    // No archives kept; second write replaces the active file content.
    expect(fs.readFileSync(filePath, "utf8")).toBe("after\n");
    expect(fs.existsSync(`${filePath}.1`)).toBe(false);
  });
});
