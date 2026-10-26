// Verifies ordered append logs retain restrictive permissions and reject symlinks.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as logging from "../logging/subsystem.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const logger = logging.createSubsystemLogger("agents/diagnostic-writer");
const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
const createLogger = vi.spyOn(logging, "createSubsystemLogger").mockReturnValue(logger);
const { getQueuedFileWriter } = await import("./queued-file-writer.js");

afterAll(() => {
  createLogger.mockRestore();
  warn.mockRestore();
});
beforeEach(() => {
  warn.mockClear();
});

describe("getQueuedFileWriter", () => {
  it("writes queued lines in order with restrictive permissions", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("line\n");
    await writer.write("next\n");

    expect(fs.readFileSync(filePath, "utf8")).toBe("line\nnext\n");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses to append through a symlink", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const targetPath = path.join(tmpDir, "target.txt");
    const filePath = path.join(tmpDir, "trace.jsonl");
    fs.writeFileSync(targetPath, "before\n", "utf8");
    fs.symlinkSync(targetPath, filePath);
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("after\n");
    await writer.write("still blocked\n");

    expect(fs.readFileSync(targetPath, "utf8")).toBe("before\n");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Diagnostic log write failed; check the configured log path",
      { filePath, error: expect.anything() },
    );
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
    await writer.write("still blocked\n");

    expect(fs.existsSync(path.join(targetDir, "trace.jsonl"))).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reports failed directory preparation once without rejecting diagnostic writes", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const blockedDir = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blockedDir, "unchanged", "utf8");
    const filePath = path.join(blockedDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath);
    writer.write("line\n");
    await expect(writer.write("next\n")).resolves.toBeUndefined();
    expect(fs.readFileSync(blockedDir, "utf8")).toBe("unchanged");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Diagnostic log write failed; check the configured log path",
      { filePath, error: expect.anything() },
    );
  });
});
