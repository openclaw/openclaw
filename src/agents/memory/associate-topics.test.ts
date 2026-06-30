// 03-02 tag/association producer: segmentation topic labels become durable tags
// linked to their non-noise spans/boxes. Deterministic, idempotent, noise excluded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { associateSegmentationTopics, topicTagId } from "./associate-topics.js";
import { listMemoryAssociations, listMemoryTags } from "./associative-store.js";
import { segmentConversationTurns } from "./segment-spans.js";
import { appendTurns, type NewTurn } from "./turns-store.js";

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function turn(idempotencyKey: string, content: string): NewTurn {
  return { role: "user", content, contentHash: `hash-${idempotencyKey}`, idempotencyKey, ts: 1 };
}

/** Seed two distinct non-noise topics plus one suppressed turn, then segment. */
function seedAndSegment(s: ReturnType<typeof scope>) {
  appendTurns({
    ...s,
    turns: [
      turn("k1", "memory accordion design notes"),
      turn("k2", "telegram channel delivery routing"),
      turn("k3", "[SILENT] cron heartbeat tick"),
    ],
  });
  return segmentConversationTurns(s);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("associate-topics", () => {
  it("derives deterministic, session-independent tag ids", () => {
    expect(topicTagId("memory")).toBe(topicTagId("  Memory  "));
    expect(topicTagId("memory")).not.toBe(topicTagId("telegram"));
    expect(topicTagId("memory")).toMatch(/^topic-[0-9a-f]{16}$/);
  });

  it("tags every non-noise span and box, excluding suppressed turns", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-associate-topics-")));
    const segmentation = seedAndSegment(s);
    const result = associateSegmentationTopics({ ...s, segmentation });

    // memory + telegram only; the [SILENT] span carries no topic and is skipped.
    expect(result.tags).toBe(2);
    expect(
      listMemoryTags(s)
        .map((tag) => tag.label)
        .toSorted(),
    ).toEqual(["memory", "telegram"]);

    const associations = listMemoryAssociations(s);
    // Two topics × {span, box} = four links; none point at the suppressed span.
    expect(associations).toHaveLength(4);
    expect(associations.map((row) => row.target_type).toSorted()).toEqual([
      "box",
      "box",
      "span",
      "span",
    ]);
    expect(associations.every((row) => row.tag_id != null && row.source === "agent")).toBe(true);
    expect(associations.some((row) => row.tag_id === topicTagId("memory"))).toBe(true);
  });

  it("is idempotent — replaying segmentation writes no duplicate rows", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-associate-topics-")));
    const segmentation = seedAndSegment(s);
    associateSegmentationTopics({ ...s, segmentation });
    const first = listMemoryAssociations(s);
    // Re-run over the same (unchanged) segmentation output.
    associateSegmentationTopics({ ...s, segmentation });
    const second = listMemoryAssociations(s);

    expect(second).toHaveLength(first.length);
    expect(listMemoryTags(s)).toHaveLength(2);
  });

  it("replay does not bump existing tag updated_at (no churn)", () => {
    // Fake timers so a replay running later would visibly advance updated_at *if* the
    // producer re-upserted — the assertion then proves it does not, independent of
    // real-clock granularity.
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-associate-topics-")));
      const segmentation = seedAndSegment(s);
      associateSegmentationTopics({ ...s, segmentation });
      const before = listMemoryTags(s).map((tag) => tag.updated_at);
      expect(before.every((ts) => ts === t0)).toBe(true);

      vi.setSystemTime(t0 + 5_000); // a replay five seconds later
      associateSegmentationTopics({ ...s, segmentation });
      const after = listMemoryTags(s).map((tag) => tag.updated_at);

      expect(after).toEqual(before); // tags untouched: no re-upsert on replay
    } finally {
      vi.useRealTimers();
    }
  });
});
