import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "vitest";
import { SessionRecall } from "../src/session-intel/recall.js";
import { SessionIndex } from "../src/session-intel/session-index.js";

describe("SessionIndex", () => {
  let index: SessionIndex;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mabos-test-session-${Date.now()}.db`);
    index = new SessionIndex(dbPath);
  });

  afterEach(() => {
    index.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  it("indexes and searches sessions", () => {
    index.indexSession({
      id: "sess-1",
      agentId: "ceo",
      companyId: "default",
      source: "cli",
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 2,
      title: "Revenue Planning",
      summary: null,
    });
    index.indexMessage({
      sessionId: "sess-1",
      role: "user",
      content: "What is our quarterly revenue target?",
      toolName: null,
      timestamp: Date.now(),
    });
    index.indexMessage({
      sessionId: "sess-1",
      role: "assistant",
      content: "The quarterly revenue target is $3.4M based on current projections.",
      toolName: null,
      timestamp: Date.now(),
    });

    const results = index.search("revenue target");
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.content.includes("revenue")));
  });

  it("filters by agentId", () => {
    index.indexSession({
      id: "s1",
      agentId: "ceo",
      companyId: "default",
      source: null,
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 1,
      title: null,
      summary: null,
    });
    index.indexSession({
      id: "s2",
      agentId: "cfo",
      companyId: "default",
      source: null,
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 1,
      title: null,
      summary: null,
    });
    index.indexMessage({
      sessionId: "s1",
      role: "user",
      content: "budget planning discussion",
      toolName: null,
      timestamp: Date.now(),
    });
    index.indexMessage({
      sessionId: "s2",
      role: "user",
      content: "budget allocation review",
      toolName: null,
      timestamp: Date.now(),
    });

    const ceoResults = index.search("budget", { agentId: "ceo" });
    assert.ok(ceoResults.every((r) => r.agentId === "ceo"));
  });

  it("counts sessions and messages", () => {
    index.indexSession({
      id: "s1",
      agentId: "a1",
      companyId: "default",
      source: null,
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 0,
      title: null,
      summary: null,
    });
    index.indexMessage({
      sessionId: "s1",
      role: "user",
      content: "hello world",
      toolName: null,
      timestamp: Date.now(),
    });

    assert.equal(index.getSessionCount(), 1);
    assert.equal(index.getMessageCount(), 1);
  });
});

describe("SessionRecall", () => {
  let index: SessionIndex;
  let recall: SessionRecall;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mabos-test-recall-${Date.now()}.db`);
    index = new SessionIndex(dbPath);
    recall = new SessionRecall(index);
  });

  afterEach(() => {
    index.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  it("groups results by session", async () => {
    index.indexSession({
      id: "s1",
      agentId: "ceo",
      companyId: "default",
      source: null,
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 2,
      title: "Strategy Meeting",
      summary: null,
    });
    index.indexMessage({
      sessionId: "s1",
      role: "user",
      content: "discuss market strategy for Q2",
      toolName: null,
      timestamp: Date.now(),
    });
    index.indexMessage({
      sessionId: "s1",
      role: "assistant",
      content: "our market strategy should focus on premium segments",
      toolName: null,
      timestamp: Date.now(),
    });

    const results = await recall.recall({ query: "market strategy" });
    assert.ok(results.length > 0);
    assert.equal(results[0].sessionId, "s1");
    assert.ok(results[0].messages.length >= 1);
  });

  it("returns empty for no matches", async () => {
    const results = await recall.recall({ query: "nonexistent topic xyz123" });
    assert.equal(results.length, 0);
  });
});
