import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

describe("QueuedFileWriter", () => {
  const writers = new Map<string, QueuedFileWriter>();

  afterEach(() => {
    writers.clear();
  });

  it("writes lines to a file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qfw-test-"));
    const filePath = path.join(dir, "test.log");
    const writer = getQueuedFileWriter(writers, filePath);

    writer.write("line1\n");
    writer.write("line2\n");

    await writer.drain();

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("line1\nline2\n");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reuses existing writer for same filePath", () => {
    const dir = os.tmpdir();
    const filePath = path.join(dir, "qfw-reuse.log");
    const w1 = getQueuedFileWriter(writers, filePath);
    const w2 = getQueuedFileWriter(writers, filePath);
    expect(w1).toBe(w2);
  });

  it("warns after consecutive write failures", async () => {
    const dir = path.join(os.tmpdir(), "qfw-no-exist-" + process.pid);
    const filePath = path.join(dir, "sub", "test.log");

    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    // Create a directory where the file should be — appendFile will fail
    await fs.mkdir(filePath, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = getQueuedFileWriter(writers, filePath);

    writer.write("a\n");
    writer.write("b\n");
    writer.write("c\n");

    await writer.drain();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("QueuedFileWriter");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("3 consecutive write failures");
    expect(warnSpy.mock.calls[0]?.[0]).toContain(filePath);

    warnSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("warns at threshold and then periodically, not on every failure", async () => {
    const dir = path.join(os.tmpdir(), "qfw-periodic-warn-" + process.pid);
    const filePath = path.join(dir, "sub", "test.log");

    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(filePath, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = getQueuedFileWriter(writers, filePath);

    // Trigger 5 write failures — should warn only on failure #3 (threshold)
    // Failures 4 and 5 are silent (not at a periodic interval)
    for (let i = 0; i < 5; i++) {
      writer.write(`fail-${i}\n`);
    }

    await writer.drain();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("3 consecutive write failures");

    warnSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("re-warns periodically at every 30 consecutive failures after threshold", async () => {
    const dir = path.join(os.tmpdir(), "qfw-periodic-30-" + process.pid);
    const filePath = path.join(dir, "sub", "test.log");

    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(filePath, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = getQueuedFileWriter(writers, filePath);

    // Trigger 63 write failures — should warn at 3, 30, and 60
    for (let i = 0; i < 63; i++) {
      writer.write(`fail-${i}\n`);
    }

    await writer.drain();

    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("3 consecutive write failures");
    expect(warnSpy.mock.calls[1]?.[0]).toContain("30 consecutive write failures");
    expect(warnSpy.mock.calls[2]?.[0]).toContain("60 consecutive write failures");

    warnSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resets failure count on successful write", async () => {
    const dir = path.join(os.tmpdir(), "qfw-reset-" + process.pid);
    const filePath = path.join(dir, "sub", "test.log");

    // Create directory structure where the file path is a directory (causes write failure)
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(filePath, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = getQueuedFileWriter(writers, filePath);

    // Induce 2 failures (below threshold — no warning yet)
    writer.write("fail1\n");
    writer.write("fail2\n");

    await writer.drain();
    expect(warnSpy).not.toHaveBeenCalled();

    // Fix the path: remove the directory and let appendFile create a real file
    await fs.rm(filePath, { recursive: true, force: true });

    // Successful write — should reset counter to 0
    writer.write("success\n");

    await writer.drain();
    expect(warnSpy).not.toHaveBeenCalled();

    // Now re-break the path
    await fs.rm(filePath, { force: true });
    await fs.mkdir(filePath, { recursive: true });

    // Induce 2 more failures — if counter reset properly, still below threshold
    writer.write("fail3\n");
    writer.write("fail4\n");

    await writer.drain();

    // Should NOT have warned — counter was reset by success, so we're at 2 again
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
