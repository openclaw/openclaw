import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter.js";

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

describe("RateLimiter", () => {
  let limiter: RateLimiter;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rl-"));
    limiter = new RateLimiter(DEFAULT_RATE_LIMITS);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows calls within limits", () => {
    expect(limiter.check("read")).toBe(true);
    limiter.record("read");
    expect(limiter.getCount("read")).toBe(1);
  });

  it("blocks when limit exceeded", () => {
    const limits = { read: 3, write: 2, delete: 1, export: 1 };
    const small = new RateLimiter(limits);

    small.record("delete");
    expect(small.check("delete")).toBe(false);
  });

  it("slides window after time passes", () => {
    const limits = { read: 2, write: 2, delete: 1, export: 1 };
    const small = new RateLimiter(limits, 1000); // 1 second window

    small.record("delete");
    expect(small.check("delete")).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(small.check("delete")).toBe(true);
  });

  it("returns current counts for audit", () => {
    limiter.record("read");
    limiter.record("read");
    limiter.record("write");

    const counts = limiter.getCounts();
    expect(counts.read).toBe(2);
    expect(counts.write).toBe(1);
    expect(counts.delete).toBe(0);
  });

  it("uses default limits from design doc", () => {
    expect(DEFAULT_RATE_LIMITS.read).toBe(100);
    expect(DEFAULT_RATE_LIMITS.write).toBe(20);
    expect(DEFAULT_RATE_LIMITS.delete).toBe(5);
    expect(DEFAULT_RATE_LIMITS.export).toBe(5);
  });

  it("persists and restores state from disk (Gap 8)", () => {
    const persistPath = path.join(tmpDir, "rate-limiter.json");
    const persisted = new RateLimiter(
      { read: 100, write: 20, delete: 5, export: 5 },
      DEFAULT_WINDOW_MS,
      persistPath,
    );
    persisted.record("delete");
    persisted.record("delete");

    // Create new instance from same file — should restore state
    const restored = new RateLimiter(
      { read: 100, write: 20, delete: 5, export: 5 },
      DEFAULT_WINDOW_MS,
      persistPath,
    );
    expect(restored.getCount("delete")).toBe(2);
  });
});
