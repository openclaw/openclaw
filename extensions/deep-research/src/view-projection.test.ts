import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { renderResearchDocument } from "./evidence.js";
import type { ResearchJob } from "./job-state.js";
import { projectResearchJob } from "./view-projection.js";

const job: ResearchJob = {
  version: 1,
  id: "a".repeat(64),
  request: { question: "Research [S1] café" },
  agentId: "main",
  sessionKey: "agent:main:research",
  sessionId: "one",
  createdAt: 1,
  deadlineAt: 0,
  state: "queued",
  progress: "Accepted",
  recovery: "ready",
};

describe("retained research view projection", () => {
  it("keeps unknown counts absent, distinguishes cancellation requests, and never resumes unknown submission", () => {
    const queued = projectResearchJob(job);
    expect(queued.counts).toBeUndefined();
    expect(queued.actions).toEqual(["cancel"]);
    const pending = projectResearchJob({ ...job, state: "paused", cancelRequested: true });
    expect(pending.state).toBe("paused");
    expect(pending.cancelRequested).toBe(true);
    expect(pending.actions).toEqual([]);
    expect(
      projectResearchJob({ ...job, state: "cancelled", cancelRequested: true }).cancelRequested,
    ).toBe(false);
    expect(projectResearchJob({ ...job, state: "indeterminate" }).actions).toEqual([]);
    expect(projectResearchJob({ ...job, state: "paused", recovery: "deferred" }).actions).toEqual(
      [],
    );
    expect(projectResearchJob({ ...job, state: "paused" }).actions).toEqual(["cancel", "resume"]);
  });
  it("emits exact UTF-8 citations only at producer-authored references, not bracketed request text", () => {
    const sources = [
      {
        id: "S1",
        title: "Café source",
        text: "Evidence of café operations is retained.",
        retrievedAt: "2026-01-01",
        fingerprint: "abc",
        extraction: "supplied-text-v1" as const,
      },
    ];
    const source = sources[0];
    assert.ok(source);
    const findings = [
      {
        statement: "☕ Café [S1] operations",
        evidence: [{ sourceId: "S1", quote: source.text }],
        support: "model-supported" as const,
      },
    ];
    const document = renderResearchDocument(job.request.question, findings, sources, []);
    const view = projectResearchJob({
      ...job,
      state: "completed",
      result: {
        version: 1,
        engine: "portable",
        status: "completed",
        report: document.report,
        reportCitations: document.citations,
        sources,
        findings,
        gaps: [],
        limitations: [],
        usage: { modelCalls: 3, searches: 0, fetches: 0, reportedTokens: 1, tokensComplete: false },
        route: { model: "fixture", runtime: "direct-provider" },
      },
    });
    expect(view.citations).toHaveLength(1);
    const citation = view.citations[0];
    assert.ok(citation);
    expect(
      Buffer.from(view.report!).subarray(citation.startByte, citation.endByte).toString(),
    ).toBe("[S1]");
    expect(view.sources[0]?.provenance).toBe("supplied-document");
    expect(view.findings[0]?.support).toBe("model-supported");
  });
  it("keeps managed attribution separate from fetched text and omits invalid/missing citation ranges", () => {
    const view = projectResearchJob({
      ...job,
      state: "partial",
      result: {
        version: 1,
        engine: "managed",
        status: "partial",
        report: "Café [x]",
        sources: [],
        findings: [],
        gaps: ["Unresolved"],
        limitations: [],
        usage: { modelCalls: 0, searches: 0, fetches: 0, reportedTokens: 0, tokensComplete: false },
        route: { model: "managed", runtime: "managed-service" },
        providerCitations: [
          { url: "https://example.org", startByte: 6, endByte: 9 },
          { url: "https://example.net" },
          { url: "https://bad.example", startByte: 4, endByte: 5 },
          { url: "https://outside.example", startByte: 0, endByte: 900 },
        ],
      },
    });
    expect(view.counts).toBeUndefined();
    expect(view.sources).toHaveLength(4);
    expect(
      view.sources.every((source) => source.provenance === "provider-cited" && !source.excerpt),
    ).toBe(true);
    expect(view.citations).toEqual([{ sourceId: "P1", startByte: 6, endByte: 9 }]);
  });
});
