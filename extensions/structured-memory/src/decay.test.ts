import { describe, expect, it } from "vitest";
import type { ResolvedStructuredMemoryConfig } from "./config";
import { computeRelevance, isProtected } from "./decay";
import type { MemoryRecord } from "./types";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: "test-1",
    type: "fact",
    summary: "test record",
    confidence: 0.8,
    importance: 5,
    salience: 0.5,
    status: "active",
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    expire_at: null,
    activate_at: null,
    contradiction_flag: 0,
    allow_coexistence: 0,
    critical: 0,
    consolidation_count: 0,
    content: "test content",
    keywords: "test",
    agent_id: "test-agent",
    source_session_id: null,
    attributes: "{}",
    ...overrides,
  };
}

const defaultConfig: Pick<ResolvedStructuredMemoryConfig, "decay"> = {
  decay: { halfLifeDays: 14, minMaintenanceScore: 0.1 },
};

describe("isProtected", () => {
  it("returns true for critical records", () => {
    expect(isProtected({ critical: 1, activate_at: null })).toBe(true);
  });

  it("returns true for future activate_at", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    expect(isProtected({ critical: 0, activate_at: future })).toBe(true);
  });

  it("returns false for past activate_at", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(isProtected({ critical: 0, activate_at: past })).toBe(false);
  });

  it("returns false for normal record", () => {
    expect(isProtected({ critical: 0, activate_at: null })).toBe(false);
  });
});

describe("computeRelevance", () => {
  it("fresh record has high relevance", () => {
    const r = computeRelevance(makeRecord(), defaultConfig);
    expect(r.relevance).toBeGreaterThan(0.1);
    expect(r.should_archive).toBe(false);
  });

  it("old record decays to low relevance", () => {
    const oldDate = new Date(Date.now() - 86400000 * 60).toISOString();
    const r = computeRelevance(
      makeRecord({ updated_at: oldDate, created_at: oldDate }),
      defaultConfig,
    );
    expect(r.relevance).toBeLessThan(0.1);
    expect(r.should_archive).toBe(true);
  });

  it("critical record never archives", () => {
    const oldDate = new Date(Date.now() - 86400000 * 365).toISOString();
    const r = computeRelevance(
      makeRecord({ critical: 1, updated_at: oldDate, created_at: oldDate }),
      defaultConfig,
    );
    expect(r.should_archive).toBe(false);
  });

  it("future activate_at prevents archive and reduces relevance", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const r = computeRelevance(makeRecord({ activate_at: future }), defaultConfig);
    expect(r.should_archive).toBe(false);
    expect(r.archive_reason).toContain("activates_at");
  });

  it("past activate_at allows normal behavior", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = computeRelevance(makeRecord({ activate_at: past }), defaultConfig);
    expect(r.relevance).toBeGreaterThan(0);
  });

  it("expire_at in the past forces archive", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = computeRelevance(makeRecord({ expire_at: past }), defaultConfig);
    expect(r.should_archive).toBe(true);
    expect(r.relevance).toBe(0);
    expect(r.archive_reason).toContain("expired");
  });

  it("expire_at in the future has normal relevance", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const r = computeRelevance(makeRecord({ expire_at: future }), defaultConfig);
    expect(r.should_archive).toBe(false);
    expect(r.relevance).toBeGreaterThan(0);
  });

  it("recent access boosts relevance", () => {
    const recentAccess = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const r = computeRelevance(makeRecord({ last_accessed_at: recentAccess }), defaultConfig);
    expect(r.access_boost).toBe(1.0);
  });

  it("access 5 days ago gives 0.8 boost", () => {
    const fiveDaysAgo = new Date(Date.now() - 86400000 * 5).toISOString();
    const r = computeRelevance(makeRecord({ last_accessed_at: fiveDaysAgo }), defaultConfig);
    expect(r.access_boost).toBe(0.8);
  });

  it("access 10 days ago gives 0.5 boost", () => {
    const tenDaysAgo = new Date(Date.now() - 86400000 * 10).toISOString();
    const r = computeRelevance(makeRecord({ last_accessed_at: tenDaysAgo }), defaultConfig);
    expect(r.access_boost).toBe(0.5);
  });

  it("high importance and confidence increase relevance", () => {
    const r = computeRelevance(
      makeRecord({ importance: 10, confidence: 1.0, salience: 1.0 }),
      defaultConfig,
    );
    expect(r.relevance).toBeGreaterThan(0.5);
  });

  it("includes archive reason when archiving", () => {
    const oldDate = new Date(Date.now() - 86400000 * 365).toISOString();
    const r = computeRelevance(
      makeRecord({ updated_at: oldDate, created_at: oldDate, importance: 1 }),
      defaultConfig,
    );
    if (r.should_archive) {
      expect(r.archive_reason).toContain("below threshold");
    }
  });
});
