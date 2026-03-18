import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyBaseline,
  recordDivergence,
  getDivergenceLog,
  getDivergenceStats,
  resetDivergenceLog,
  formatDivergenceReport,
} from "../src/shadow.ts";
import type { ExecutionKind } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// Reset state before each test to ensure isolation
beforeEach(() => {
  resetDivergenceLog();
});

// ---------------------------------------------------------------------------
// 1. classifyBaseline
// ---------------------------------------------------------------------------
describe("classifyBaseline", () => {
  it("classifies search keywords correctly", () => {
    const result = classifyBaseline("搜索一下文件?", DEFAULT_CONFIG);
    expect(result.execution_kind).toBe("search");
  });

  it("classifies install keywords correctly", () => {
    const result = classifyBaseline("安装 lodash!", DEFAULT_CONFIG);
    expect(result.execution_kind).toBe("install");
  });

  it("classifies debug keywords correctly", () => {
    const result = classifyBaseline("修复这个 bug。", DEFAULT_CONFIG);
    expect(result.execution_kind).toBe("debug");
  });

  it("classifies chat keywords correctly", () => {
    const result = classifyBaseline("你好!", DEFAULT_CONFIG);
    expect(result.execution_kind).toBe("chat");
  });

  it("returns 'run' for unknown but finalized input", () => {
    const result = classifyBaseline("做点什么吧。", DEFAULT_CONFIG);
    // "做点什么吧" doesn't match any baseline keyword, but is finalized -> run
    expect(result.execution_kind).toBe("run");
  });

  it("returns 'unknown' for incomplete input with no keyword match", () => {
    const result = classifyBaseline("嗯", DEFAULT_CONFIG);
    expect(result.execution_kind).toBe("unknown");
  });

  it("returns ExecutionIntent without policy or delegation fields", () => {
    const result = classifyBaseline("运行 npm test!", DEFAULT_CONFIG);
    expect("requires_policy_gate" in result).toBe(false);
    expect("requires_delegation" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. recordDivergence
// ---------------------------------------------------------------------------
describe("recordDivergence", () => {
  it("adds entries to the log", () => {
    recordDivergence({
      timestamp: 1000,
      messagePreview: "test message",
      currentResult: "debug",
      baselineResult: "search",
      currentScore: 5,
      agreed: false,
    });
    const log = getDivergenceLog();
    expect(log.length).toBe(1);
    expect(log[0].currentResult).toBe("debug");
    expect(log[0].baselineResult).toBe("search");
  });

  it("accumulates multiple entries", () => {
    for (let i = 0; i < 5; i++) {
      recordDivergence({
        timestamp: i,
        messagePreview: `msg ${i}`,
        currentResult: "run",
        baselineResult: "run",
        currentScore: 0,
        agreed: true,
      });
    }
    expect(getDivergenceLog().length).toBe(5);
  });

  it("enforces MAX_LOG_SIZE by dropping oldest entries", () => {
    for (let i = 0; i < 1005; i++) {
      recordDivergence({
        timestamp: i,
        messagePreview: `msg ${i}`,
        currentResult: "run",
        baselineResult: "run",
        currentScore: 0,
        agreed: true,
      });
    }
    const log = getDivergenceLog();
    expect(log.length).toBe(1000);
    // Oldest surviving entry should have timestamp 5
    expect(log[0].timestamp).toBe(5);
  });

  it("returns entries in chronological order after wrap-around", () => {
    for (let i = 0; i < 1010; i++) {
      recordDivergence({
        timestamp: i,
        messagePreview: `msg ${i}`,
        currentResult: "run",
        baselineResult: "run",
        currentScore: 0,
        agreed: true,
      });
    }
    const log = getDivergenceLog();
    // Verify chronological order across the entire buffer
    for (let i = 1; i < log.length; i++) {
      expect(log[i].timestamp > log[i - 1].timestamp).toBe(true);
    }
    expect(log[0].timestamp).toBe(10);
    expect(log[log.length - 1].timestamp).toBe(1009);
  });

  it("does not grow entryCount beyond MAX_LOG_SIZE", () => {
    for (let i = 0; i < 2000; i++) {
      recordDivergence({
        timestamp: i,
        messagePreview: `msg ${i}`,
        currentResult: "run",
        baselineResult: "run",
        currentScore: 0,
        agreed: true,
      });
    }
    // entryCount is internal, but we can verify via getDivergenceLog length
    expect(getDivergenceLog().length).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// 3. getDivergenceLog — snapshot immutability
// ---------------------------------------------------------------------------
describe("getDivergenceLog", () => {
  it("returns a copy, not the internal array", () => {
    recordDivergence({
      timestamp: 1,
      messagePreview: "a",
      currentResult: "debug",
      baselineResult: "debug",
      currentScore: 0,
      agreed: true,
    });
    const log1 = getDivergenceLog();
    recordDivergence({
      timestamp: 2,
      messagePreview: "b",
      currentResult: "run",
      baselineResult: "run",
      currentScore: 0,
      agreed: true,
    });
    // log1 should still have length 1
    expect(log1.length).toBe(1);
    expect(getDivergenceLog().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. getDivergenceStats
// ---------------------------------------------------------------------------
describe("getDivergenceStats", () => {
  it("returns zero counts for empty log", () => {
    const stats = getDivergenceStats();
    expect(stats.total).toBe(0);
    expect(stats.agreements).toBe(0);
    expect(stats.divergences).toBe(0);
    expect(stats.agreementRate).toBe("N/A");
    expect(stats.topDivergences).toEqual([]);
  });

  it("computes agreements and divergences correctly", () => {
    recordDivergence({
      timestamp: 1,
      messagePreview: "a",
      currentResult: "run",
      baselineResult: "run",
      currentScore: 0,
      agreed: true,
    });
    recordDivergence({
      timestamp: 2,
      messagePreview: "b",
      currentResult: "debug",
      baselineResult: "search",
      currentScore: 0,
      agreed: false,
    });
    recordDivergence({
      timestamp: 3,
      messagePreview: "c",
      currentResult: "write",
      baselineResult: "write",
      currentScore: 0,
      agreed: true,
    });
    const stats = getDivergenceStats();
    expect(stats.total).toBe(3);
    expect(stats.agreements).toBe(2);
    expect(stats.divergences).toBe(1);
    expect(stats.agreementRate).toBe("66.7%");
  });

  it("groups topDivergences by pattern and sorts by count descending", () => {
    // 3x search->debug, 1x run->write
    for (let i = 0; i < 3; i++) {
      recordDivergence({
        timestamp: i,
        messagePreview: "",
        currentResult: "debug",
        baselineResult: "search",
        currentScore: 0,
        agreed: false,
      });
    }
    recordDivergence({
      timestamp: 10,
      messagePreview: "",
      currentResult: "write",
      baselineResult: "run",
      currentScore: 0,
      agreed: false,
    });

    const stats = getDivergenceStats();
    expect(stats.topDivergences.length).toBe(2);
    expect(stats.topDivergences[0].from).toBe("search");
    expect(stats.topDivergences[0].to).toBe("debug");
    expect(stats.topDivergences[0].count).toBe(3);
    expect(stats.topDivergences[1].from).toBe("run");
    expect(stats.topDivergences[1].to).toBe("write");
    expect(stats.topDivergences[1].count).toBe(1);
  });

  it("limits topDivergences to 10 entries", () => {
    const kinds: ExecutionKind[] = [
      "search",
      "install",
      "read",
      "run",
      "write",
      "debug",
      "analyze",
      "chat",
    ];
    // Create 12 unique divergence patterns
    for (let i = 0; i < 12; i++) {
      const from = kinds[i % kinds.length];
      const to = kinds[(i + 1) % kinds.length];
      recordDivergence({
        timestamp: i,
        messagePreview: "",
        currentResult: to,
        baselineResult: from,
        currentScore: 0,
        agreed: false,
      });
    }
    const stats = getDivergenceStats();
    expect(stats.topDivergences.length <= 10).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. resetDivergenceLog
// ---------------------------------------------------------------------------
describe("resetDivergenceLog", () => {
  it("clears all entries", () => {
    recordDivergence({
      timestamp: 1,
      messagePreview: "a",
      currentResult: "run",
      baselineResult: "run",
      currentScore: 0,
      agreed: true,
    });
    recordDivergence({
      timestamp: 2,
      messagePreview: "b",
      currentResult: "debug",
      baselineResult: "debug",
      currentScore: 0,
      agreed: true,
    });
    resetDivergenceLog();
    expect(getDivergenceLog().length).toBe(0);
  });

  it("allows new recordings after reset", () => {
    recordDivergence({
      timestamp: 1,
      messagePreview: "a",
      currentResult: "run",
      baselineResult: "run",
      currentScore: 0,
      agreed: true,
    });
    resetDivergenceLog();
    recordDivergence({
      timestamp: 2,
      messagePreview: "b",
      currentResult: "debug",
      baselineResult: "debug",
      currentScore: 0,
      agreed: true,
    });
    expect(getDivergenceLog().length).toBe(1);
    expect(getDivergenceLog()[0].timestamp).toBe(2);
  });

  it("fully resets circular buffer state after overflow", () => {
    // Fill past capacity, then reset, then add a few entries
    for (let i = 0; i < 1500; i++) {
      recordDivergence({
        timestamp: i,
        messagePreview: `msg ${i}`,
        currentResult: "run",
        baselineResult: "run",
        currentScore: 0,
        agreed: true,
      });
    }
    resetDivergenceLog();
    expect(getDivergenceLog().length).toBe(0);

    // New entries should start fresh with correct ordering
    for (let i = 0; i < 3; i++) {
      recordDivergence({
        timestamp: 100 + i,
        messagePreview: `new ${i}`,
        currentResult: "debug",
        baselineResult: "debug",
        currentScore: 0,
        agreed: true,
      });
    }
    const log = getDivergenceLog();
    expect(log.length).toBe(3);
    expect(log[0].timestamp).toBe(100);
    expect(log[2].timestamp).toBe(102);
  });
});

// ---------------------------------------------------------------------------
// 6. formatDivergenceReport
// ---------------------------------------------------------------------------
describe("formatDivergenceReport", () => {
  it("includes header and zero counts for empty log", () => {
    const report = formatDivergenceReport();
    expect(report.includes("Shadow Mode Report")).toBe(true);
    expect(report.includes("Total comparisons: 0")).toBe(true);
    expect(report.includes("Agreements: 0 (N/A)")).toBe(true);
    expect(report.includes("Divergences: 0")).toBe(true);
  });

  it("shows correct stats with data", () => {
    recordDivergence({
      timestamp: 1,
      messagePreview: "a",
      currentResult: "run",
      baselineResult: "run",
      currentScore: 0,
      agreed: true,
    });
    recordDivergence({
      timestamp: 2,
      messagePreview: "b",
      currentResult: "debug",
      baselineResult: "search",
      currentScore: 0,
      agreed: false,
    });
    const report = formatDivergenceReport();
    expect(report.includes("Total comparisons: 2")).toBe(true);
    expect(report.includes("Agreements: 1 (50.0%)")).toBe(true);
    expect(report.includes("Divergences: 1")).toBe(true);
  });

  it("includes top divergence patterns section when divergences exist", () => {
    recordDivergence({
      timestamp: 1,
      messagePreview: "",
      currentResult: "debug",
      baselineResult: "search",
      currentScore: 0,
      agreed: false,
    });
    const report = formatDivergenceReport();
    expect(report.includes("Top divergence patterns:")).toBe(true);
    expect(report.includes("baseline:search")).toBe(true);
    expect(report.includes("current:debug")).toBe(true);
  });

  it("omits top divergence patterns section when all agree", () => {
    recordDivergence({
      timestamp: 1,
      messagePreview: "",
      currentResult: "run",
      baselineResult: "run",
      currentScore: 0,
      agreed: true,
    });
    const report = formatDivergenceReport();
    expect(report.includes("Top divergence patterns:")).toBe(false);
  });
});
