import { mkdirSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFileLogger, composeLoggers } from "../file-logger.js";
import type { Logger } from "../types.js";

describe("createFileLogger", () => {
  let testDir: string;
  let logPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-logger-test-${Date.now()}`);
    logPath = join(testDir, "test.log");
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("writes log line with ISO timestamp and level tag", () => {
    const logger = createFileLogger(logPath);

    logger.info("hello world");

    const content = readFileSync(logPath, "utf-8");
    // Format: [ISO_TIMESTAMP] [INFO] hello world
    expect(content).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] \[INFO\] hello world\n$/,
    );
  });

  it("appends multiple entries without overwriting", () => {
    const logger = createFileLogger(logPath);

    logger.info("first");
    logger.error("second");
    logger.warn("third");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[INFO] first");
    expect(lines[1]).toContain("[ERROR] second");
    expect(lines[2]).toContain("[WARN] third");
  });

  it("creates parent directory if missing", () => {
    const nestedPath = join(testDir, "nested", "deep", "test.log");
    const logger = createFileLogger(nestedPath);

    logger.info("nested log");

    const content = readFileSync(nestedPath, "utf-8");
    expect(content).toContain("[INFO] nested log");
  });

  it("silently swallows write errors", () => {
    // Use an invalid path (directory as file) to trigger a write error
    mkdirSync(testDir, { recursive: true });
    mkdirSync(logPath, { recursive: true }); // logPath is now a directory, appendFile will fail

    const logger = createFileLogger(logPath);

    // Should not throw
    expect(() => logger.info("should not crash")).not.toThrow();
  });
});

describe("composeLoggers", () => {
  it("delegates all calls to both inner loggers", () => {
    const a: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const b: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const composed = composeLoggers(a, b);

    composed.info("info msg");
    composed.warn("warn msg");
    composed.error("error msg");

    expect(a.info).toHaveBeenCalledWith("info msg");
    expect(b.info).toHaveBeenCalledWith("info msg");
    expect(a.warn).toHaveBeenCalledWith("warn msg");
    expect(b.warn).toHaveBeenCalledWith("warn msg");
    expect(a.error).toHaveBeenCalledWith("error msg");
    expect(b.error).toHaveBeenCalledWith("error msg");
  });
});
