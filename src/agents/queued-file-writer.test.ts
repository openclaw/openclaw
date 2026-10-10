// Verifies ordered append logs retain restrictive permissions and reject symlinks.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getQueuedFileWriter } from "./queued-file-writer.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("getQueuedFileWriter", () => {
  it("flushes queued lines in order with restrictive permissions", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("line\n");
    writer.write("next\n");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("line\nnext\n");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("refuses to append through a symlink", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
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
    // Parent directory symlinks are as dangerous as leaf-file symlinks.
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const targetDir = path.join(tmpDir, "target");
    const linkDir = path.join(tmpDir, "link");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir);
    const writer = getQueuedFileWriter(new Map(), path.join(linkDir, "trace.jsonl"));

    writer.write("after\n");
    await writer.flush();

    expect(fs.existsSync(path.join(targetDir, "trace.jsonl"))).toBe(false);
  });
});
