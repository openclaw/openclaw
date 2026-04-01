/**
 * Tests for cognitive router fixes:
 * 1. Goal ID parsing with alphanumeric IDs (G-CFO-001)
 * 2. Intention ID parsing with alphanumeric IDs (I-CFO-001)
 * 3. Belief deduplication with quoted/unquoted variants
 * 4. Demand score computation with proper signals
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, assert, beforeEach } from "vitest";
import { DEFAULT_ROLE_THRESHOLDS } from "../src/tools/cognitive-router-types.js";
import { computeCognitiveDemand } from "../src/tools/cognitive-router.js";
import { scanGoalState, scanDeadlines, scanInbox } from "../src/tools/cognitive-signal-scanners.js";

const TEST_DIR = join(tmpdir(), `mabos-cognitive-fixes-${randomUUID()}`);

beforeEach(async () => {
  try {
    await rm(TEST_DIR, { recursive: true });
  } catch {}
  await mkdir(TEST_DIR, { recursive: true });
});

describe("Goal ID parsing — alphanumeric IDs", () => {
  it("parses G-CFO-001 style IDs in Goals.md", async () => {
    const goalsContent = `# Goals — cfo

Last evaluated: 2026-03-15T00:00:00.000Z

## Active Goals

### G-CFO-001: Maintain positive cash flow
- **Status:** active
- **Priority:** 0.9
- **Progress:** 15%
- **Deadline:** 2026-06-30

### G-CFO-002: Reduce operational costs by 10%
- **Status:** active
- **Priority:** 0.7
- **Progress:** 5%
- **Deadline:** ongoing
`;
    await writeFile(join(TEST_DIR, "Goals.md"), goalsContent);

    const signals = await scanGoalState(TEST_DIR, "cfo");
    // G-CFO-001 has priority 0.9 and progress 15% (< 20%) → should be "failing"
    assert.ok(signals.length > 0, "Should detect goal signals for alphanumeric IDs");
    const failingSignal = signals.find((s) => s.summary.includes("G-CFO-001"));
    assert.ok(failingSignal, "Should detect G-CFO-001 as failing (high priority, low progress)");
  });

  it("parses G-1 style IDs too (backward compat)", async () => {
    const goalsContent = `# Goals — ceo

## Active Goals

### G-1: Strategic alignment
- **Status:** active
- **Priority:** 0.8
- **Progress:** 10%
`;
    await writeFile(join(TEST_DIR, "Goals.md"), goalsContent);

    const signals = await scanGoalState(TEST_DIR, "ceo");
    assert.ok(signals.length > 0, "Should still parse numeric-only goal IDs");
  });
});

describe("Intention ID parsing — alphanumeric IDs", () => {
  it("parses I-COO-001 style IDs in Intentions.md", async () => {
    const tomorrow = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString().split("T")[0];
    const intentionsContent = `# Intentions — coo

## Active Intentions

### I-COO-001: Optimize fulfillment pipeline
- **Status:** executing
- **Deadline:** ${tomorrow}
- **Progress:** 30%
- **Current Step:** S-2
`;
    await writeFile(join(TEST_DIR, "Intentions.md"), intentionsContent);
    // Also need Goals.md for scanDeadlines
    await writeFile(join(TEST_DIR, "Goals.md"), "# Goals — coo\n");

    const signals = await scanDeadlines(TEST_DIR, "coo");
    const intentionSignal = signals.find((s) => s.summary.includes("I-COO-001"));
    assert.ok(intentionSignal, "Should detect deadline for alphanumeric intention ID");
  });
});

describe("Demand score computation", () => {
  it("returns non-zero score when signals exist", () => {
    const signals = [
      {
        id: "SIG-1",
        source: "goal_state" as const,
        agentId: "cfo",
        timestamp: new Date().toISOString(),
        summary: "Goal G-CFO-001 failing",
        urgency: 0.9,
        stakes: 0.9,
        novelty: 0.3,
        metadata: { source: "goal_state", goalId: "G-CFO-001", transition: "failing" },
      },
    ];
    const demand = computeCognitiveDemand(
      signals,
      DEFAULT_ROLE_THRESHOLDS.cfo,
      new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    );
    assert.ok(demand.score > 0, `Demand should be non-zero, got ${demand.score}`);
    assert.ok(demand.score > 0.3, `Demand should be significant, got ${demand.score}`);
    assert.equal(demand.signalCount, 1);
  });

  it("returns 0 when no signals", () => {
    const demand = computeCognitiveDemand(
      [],
      DEFAULT_ROLE_THRESHOLDS.cfo,
      new Date().toISOString(),
    );
    assert.equal(demand.score, 0);
  });
});

describe("Inbox signal scanning", () => {
  it("detects unread inbox messages as signals", async () => {
    const inboxMessages = [
      {
        id: "msg-1",
        from: "ceo",
        to: "cfo",
        performative: "REQUEST",
        subject: "Quarterly budget review",
        content: "Please prepare Q2 budget analysis",
        priority: "high",
        timestamp: new Date().toISOString(),
        read: false,
      },
    ];
    await writeFile(join(TEST_DIR, "inbox.json"), JSON.stringify(inboxMessages));

    const signals = await scanInbox(TEST_DIR, "cfo", new Date(0).toISOString());
    assert.equal(signals.length, 1);
    assert.ok(signals[0].urgency > 0.5, "High priority should have high urgency");
    assert.ok(signals[0].stakes >= 0.7, "REQUEST performative should have high stakes");
  });

  it("skips read messages", async () => {
    const inboxMessages = [
      {
        id: "msg-1",
        from: "ceo",
        to: "cfo",
        performative: "INFORM",
        content: "FYI",
        priority: "low",
        timestamp: new Date().toISOString(),
        read: true,
      },
    ];
    await writeFile(join(TEST_DIR, "inbox.json"), JSON.stringify(inboxMessages));

    const signals = await scanInbox(TEST_DIR, "cfo", new Date(0).toISOString());
    assert.equal(signals.length, 0, "Read messages should not generate signals");
  });
});
