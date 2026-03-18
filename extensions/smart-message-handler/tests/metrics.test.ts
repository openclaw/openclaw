import { randomBytes } from "node:crypto";
import {
  existsSync,
  unlinkSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordClassification,
  recordSkippedSession,
  getMetrics,
  resetMetrics,
  formatMetricsReport,
  enablePersistence,
  disablePersistence,
  flushMetrics,
  loadPersistedMetrics,
  aggregatePersistedMetrics,
} from "../src/metrics.ts";
import type { ClassificationMetrics } from "../src/metrics.ts";

const TEST_DIR = join(process.env.HOME || "", ".openclaw/test-metrics-tmp");

function safeLogPath(): string {
  return join(TEST_DIR, `metrics-test-${randomBytes(8).toString("hex")}.jsonl`);
}

function cleanup(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    /* ignore */
  }
}

// Ensure test directory exists
if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true });
}

// Reset state before each test to ensure isolation
beforeEach(async () => {
  await flushMetrics();
  resetMetrics();
  disablePersistence();
});

// ---------------------------------------------------------------------------
// 1. recordClassification
// ---------------------------------------------------------------------------
describe("recordClassification", () => {
  it("increments totalClassifications on each call", () => {
    recordClassification("debug", false);
    recordClassification("search", false);
    const m = getMetrics();
    expect(m.totalClassifications).toBe(2);
  });

  it("increments the correct kind in kindDistribution", () => {
    recordClassification("write", false);
    recordClassification("write", false);
    recordClassification("read", false);
    const m = getMetrics();
    expect(m.kindDistribution.write).toBe(2);
    expect(m.kindDistribution.read).toBe(1);
    expect(m.kindDistribution.debug).toBe(0);
  });

  it("increments signalInjected only when signalInjected is true", () => {
    recordClassification("install", true);
    recordClassification("install", false);
    const m = getMetrics();
    expect(m.signalInjected).toBe(1);
  });

  it("accumulates all counters independently across multiple calls", () => {
    recordClassification("debug", true);
    recordClassification("chat", false);
    recordClassification("unknown", true);
    const m = getMetrics();
    expect(m.totalClassifications).toBe(3);
    expect(m.signalInjected).toBe(2);
    expect(m.kindDistribution.debug).toBe(1);
    expect(m.kindDistribution.chat).toBe(1);
    expect(m.kindDistribution.unknown).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. recordSkippedSession
// ---------------------------------------------------------------------------
describe("recordSkippedSession", () => {
  it("increments skippedSessions by 1 on each call", () => {
    recordSkippedSession();
    recordSkippedSession();
    recordSkippedSession();
    const m = getMetrics();
    expect(m.skippedSessions).toBe(3);
  });

  it("does not affect other counters", () => {
    recordSkippedSession();
    const m = getMetrics();
    expect(m.totalClassifications).toBe(0);
    expect(m.signalInjected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. getMetrics — snapshot immutability
// ---------------------------------------------------------------------------
describe("getMetrics", () => {
  it("returns a snapshot that does not reflect subsequent mutations", () => {
    recordClassification("search", false);
    const snapshot = getMetrics();
    recordClassification("debug", true);
    // snapshot must not change
    expect(snapshot.totalClassifications).toBe(1);
  });

  it("returns a kindDistribution that is a separate copy", () => {
    recordClassification("run", false);
    const snapshot = getMetrics();
    // Mutate the returned object's kindDistribution to verify isolation
    (snapshot.kindDistribution as Record<string, number>).run = 999;
    const fresh = getMetrics();
    expect(fresh.kindDistribution.run).toBe(1);
  });

  it("returns zero counts before any recordings", () => {
    const m = getMetrics();
    expect(m.totalClassifications).toBe(0);
    expect(m.skippedSessions).toBe(0);
    expect(m.signalInjected).toBe(0);
    for (const count of Object.values(m.kindDistribution)) {
      expect(count).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. resetMetrics
// ---------------------------------------------------------------------------
describe("resetMetrics", () => {
  it("sets totalClassifications back to 0 after recordings", () => {
    recordClassification("chat", false);
    recordSkippedSession();
    resetMetrics();
    const m = getMetrics();
    expect(m.totalClassifications).toBe(0);
    expect(m.skippedSessions).toBe(0);
  });

  it("sets all kindDistribution counts to 0", () => {
    recordClassification("write", true);
    recordClassification("debug", false);
    resetMetrics();
    const m = getMetrics();
    for (const count of Object.values(m.kindDistribution)) {
      expect(count).toBe(0);
    }
  });

  it("sets signalInjected to 0", () => {
    recordClassification("run", true);
    resetMetrics();
    const m = getMetrics();
    expect(m.signalInjected).toBe(0);
  });

  it("allows new recordings to accumulate correctly after a reset", () => {
    recordClassification("install", false);
    resetMetrics();
    recordClassification("search", true);
    const m = getMetrics();
    expect(m.totalClassifications).toBe(1);
    expect(m.kindDistribution.search).toBe(1);
    expect(m.kindDistribution.install).toBe(0);
    expect(m.signalInjected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. formatMetricsReport
// ---------------------------------------------------------------------------
describe("formatMetricsReport", () => {
  it("includes totalClassifications in the output", () => {
    recordClassification("debug", false);
    const report = formatMetricsReport(getMetrics());
    expect(report.includes("Total classifications: 1")).toBe(true);
  });

  it("shows 0% for all percentages when totalClassifications is 0", () => {
    const report = formatMetricsReport(getMetrics());
    expect(report.includes("0%")).toBe(true);
    expect(report.includes("NaN")).toBe(false);
  });

  it("shows correct percentage for signalInjected", () => {
    recordClassification("run", true);
    recordClassification("chat", false);
    const report = formatMetricsReport(getMetrics());
    // 1 of 2 = 50.0%
    expect(report.includes("50.0%")).toBe(true);
  });

  it("includes 'Kind distribution:' section header", () => {
    const report = formatMetricsReport(getMetrics());
    expect(report.includes("Kind distribution:")).toBe(true);
  });

  it("only lists kinds with count > 0 in the distribution section", () => {
    recordClassification("analyze", false);
    const report = formatMetricsReport(getMetrics());
    expect(report.includes("analyze:")).toBe(true);
    expect(report.includes("install:")).toBe(false);
  });

  it("shows skippedSessions count", () => {
    recordSkippedSession();
    recordSkippedSession();
    const report = formatMetricsReport(getMetrics());
    expect(report.includes("Skipped sessions: 2")).toBe(true);
  });

  it("accepts a ClassificationMetrics snapshot and produces deterministic output", () => {
    const snapshot: ClassificationMetrics = {
      totalClassifications: 10,
      kindDistribution: {
        search: 3,
        install: 0,
        read: 2,
        run: 1,
        write: 0,
        debug: 4,
        analyze: 0,
        chat: 0,
        unknown: 0,
      },
      signalInjected: 7,
      skippedSessions: 1,
    };
    const report = formatMetricsReport(snapshot);
    expect(report.includes("Total classifications: 10")).toBe(true);
    expect(report.includes("search: 3")).toBe(true);
    expect(report.includes("debug: 4")).toBe(true);
    expect(report.includes("install:")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. JSONL persistence
// ---------------------------------------------------------------------------
describe("JSONL persistence", () => {
  it("writes JSONL entries when persistence is enabled (after flush)", async () => {
    const p = safeLogPath();
    try {
      enablePersistence(p);
      recordClassification("debug", true, "sess-1");
      recordClassification("read", false, "sess-2");
      await flushMetrics();
      expect(existsSync(p)).toBe(true);
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);
      const first = JSON.parse(lines[0]);
      expect(first.k).toBe("debug");
      expect(first.si).toBe(true);
      expect(first.s).toBe("sess-1");
      const second = JSON.parse(lines[1]);
      expect(second.k).toBe("read");
      expect(second.si).toBe(false);
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });

  it("does not write when persistence is disabled", async () => {
    const p = safeLogPath();
    try {
      disablePersistence();
      recordClassification("chat", false);
      await flushMetrics();
      expect(existsSync(p)).toBe(false);
    } finally {
      cleanup(p);
    }
  });

  it("uses 'unknown' as default sessionKey when none provided", async () => {
    const p = safeLogPath();
    try {
      enablePersistence(p);
      recordClassification("run", false);
      await flushMetrics();
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      const entry = JSON.parse(lines[0]);
      expect(entry.s).toBe("unknown");
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });

  it("loadPersistedMetrics reads all entries from file", async () => {
    const p = safeLogPath();
    try {
      enablePersistence(p);
      recordClassification("search", true, "s1");
      recordClassification("write", false, "s2");
      recordClassification("debug", true, "s3");
      await flushMetrics();
      const entries = loadPersistedMetrics();
      expect(entries.length).toBe(3);
      expect(entries[0].k).toBe("search");
      expect(entries[2].k).toBe("debug");
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });

  it("loadPersistedMetrics filters by since timestamp", async () => {
    const p = safeLogPath();
    try {
      enablePersistence(p);
      recordClassification("search", false, "s1");
      await flushMetrics();
      const cutoff = Date.now() + 1;
      // Manually append an entry with a future timestamp
      const futureEntry = JSON.stringify({ t: cutoff + 100, s: "s2", k: "debug", si: false });
      appendFileSync(p, futureEntry + "\n");
      const entries = loadPersistedMetrics(cutoff);
      expect(entries.length).toBe(1);
      expect(entries[0].k).toBe("debug");
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });

  it("loadPersistedMetrics returns empty array when file does not exist", () => {
    const p = safeLogPath();
    enablePersistence(p);
    try {
      const entries = loadPersistedMetrics();
      expect(entries).toEqual([]);
    } finally {
      disablePersistence();
    }
  });

  it("aggregatePersistedMetrics produces correct ClassificationMetrics", async () => {
    const p = safeLogPath();
    try {
      enablePersistence(p);
      recordClassification("debug", true, "s1");
      recordClassification("debug", false, "s2");
      recordClassification("search", true, "s3");
      await flushMetrics();
      const entries = loadPersistedMetrics();
      const agg = aggregatePersistedMetrics(entries);
      expect(agg.totalClassifications).toBe(3);
      expect(agg.kindDistribution.debug).toBe(2);
      expect(agg.kindDistribution.search).toBe(1);
      expect(agg.signalInjected).toBe(2);
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });

  it("aggregatePersistedMetrics returns empty metrics for empty array", () => {
    const agg = aggregatePersistedMetrics([]);
    expect(agg.totalClassifications).toBe(0);
    for (const count of Object.values(agg.kindDistribution)) {
      expect(count).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Path injection prevention (H1)
// ---------------------------------------------------------------------------
describe("enablePersistence path validation", () => {
  it("throws when path is outside ~/.openclaw/", () => {
    expect(() => enablePersistence("/tmp/evil/path.jsonl")).toThrow(
      /Metrics log path must be under/,
    );
  });

  it("throws for path traversal attempts", () => {
    const traversal = join(process.env.HOME || "", ".openclaw/../../../etc/evil.jsonl");
    expect(() => enablePersistence(traversal)).toThrow(/Metrics log path must be under/);
  });

  it("accepts paths under ~/.openclaw/", () => {
    const p = safeLogPath();
    try {
      expect(() => enablePersistence(p)).not.toThrow();
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Log rotation (H3)
// ---------------------------------------------------------------------------
describe("log rotation", () => {
  it("rotates log file when it exceeds size limit on enablePersistence", () => {
    const p = safeLogPath();
    try {
      // Create a file that exceeds 5MB
      const bigLine = JSON.stringify({ t: 1, s: "x", k: "debug", si: false }) + "\n";
      const linesNeeded = Math.ceil((5.1 * 1024 * 1024) / bigLine.length);
      const bigContent = bigLine.repeat(linesNeeded);
      // Ensure parent directory exists
      const dir = join(TEST_DIR);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(p, bigContent);

      const sizeBefore = readFileSync(p, "utf-8").trim().split("\n").length;

      // enablePersistence triggers rotateLogIfNeeded
      enablePersistence(p);

      const sizeAfter = readFileSync(p, "utf-8").trim().split("\n").length;
      // After rotation, should keep roughly half the lines
      expect(sizeAfter < sizeBefore).toBe(true);
      expect(sizeAfter >= Math.floor(sizeBefore / 2) - 1).toBe(true);
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Async flush (M1)
// ---------------------------------------------------------------------------
describe("flushMetrics", () => {
  it("flushes buffered entries to disk", async () => {
    const p = safeLogPath();
    try {
      enablePersistence(p);
      recordClassification("debug", false, "flush-test");
      // Before flush, file may not exist or be empty
      await flushMetrics();
      expect(existsSync(p)).toBe(true);
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.k).toBe("debug");
      expect(entry.s).toBe("flush-test");
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });

  it("clears buffer after flush so entries are not duplicated", async () => {
    const p = safeLogPath();
    try {
      enablePersistence(p);
      recordClassification("search", false, "s1");
      await flushMetrics();
      // Second flush should not duplicate
      await flushMetrics();
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      expect(lines.length).toBe(1);
    } finally {
      disablePersistence();
      cleanup(p);
    }
  });
});
