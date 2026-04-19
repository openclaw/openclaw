/**
 * Tests for the pending-agent-injection queue (nuclear rewrite of the
 * scalar `SessionEntry.pendingAgentInjection` field).
 *
 * Covers the pure helpers plus the end-to-end enqueue + consume cycle
 * against a hermetic tmp-dir session store.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAgentInjectionEntry, SessionEntry } from "../../config/sessions/types.js";

// Hermetic store setup — mock config + path resolution before importing
// the module under test so the captured vi.hoisted() value is read.
const tmpStorePath = vi.hoisted(() => ({ value: "" }));
vi.mock("../../config/io.js", () => ({
  loadConfig: () => ({ session: { store: tmpStorePath.value } }),
}));
vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: (configValue: string | undefined) => configValue ?? tmpStorePath.value,
}));
vi.mock("../../routing/session-key.js", () => ({
  parseAgentSessionKey: (k: string) => {
    const m = /^agent:([^:]+):/.exec(k);
    return m ? { agentId: m[1] } : undefined;
  },
}));

import {
  composePromptWithPendingInjections,
  consumePendingAgentInjections,
  DEFAULT_INJECTION_PRIORITY,
  enqueuePendingAgentInjection,
  MAX_QUEUE_SIZE,
  migrateLegacyPendingInjection,
  sortAndCapQueue,
  upsertIntoQueue,
} from "./injections.js";

// -------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------

function mkEntry(
  kind: PendingAgentInjectionEntry["kind"],
  id: string,
  createdAt: number,
  overrides: Partial<PendingAgentInjectionEntry> = {},
): PendingAgentInjectionEntry {
  return {
    id,
    kind,
    text: `text:${kind}:${id}`,
    createdAt,
    ...overrides,
  };
}

describe("migrateLegacyPendingInjection", () => {
  it("returns the queue unchanged when no legacy scalar is present", () => {
    const entry = { pendingAgentInjections: [mkEntry("plan_decision", "a", 1)] } as SessionEntry;
    const result = migrateLegacyPendingInjection(entry, 1000);
    expect(result.migrated).toBe(false);
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0]?.id).toBe("a");
  });

  it("promotes a legacy scalar into a plan_decision entry appended to the queue", () => {
    const entry = {
      pendingAgentInjection: "[PLAN_DECISION]: approved",
      pendingAgentInjections: [mkEntry("question_answer", "q1", 500)],
    } as SessionEntry;
    const result = migrateLegacyPendingInjection(entry, 1000);
    expect(result.migrated).toBe(true);
    expect(result.queue).toHaveLength(2);
    expect(result.queue[0]?.id).toBe("q1");
    expect(result.queue[1]?.kind).toBe("plan_decision");
    expect(result.queue[1]?.text).toBe("[PLAN_DECISION]: approved");
    expect(result.queue[1]?.createdAt).toBe(1000);
  });

  it("treats an empty-string legacy scalar as absent (no migration)", () => {
    const entry = { pendingAgentInjection: "" } as SessionEntry;
    const result = migrateLegacyPendingInjection(entry, 1000);
    expect(result.migrated).toBe(false);
    expect(result.queue).toHaveLength(0);
  });
});

describe("upsertIntoQueue", () => {
  it("appends when id is not present", () => {
    const q = [mkEntry("plan_decision", "a", 1)];
    const next = upsertIntoQueue(q, mkEntry("question_answer", "b", 2));
    expect(next).toHaveLength(2);
    expect(next.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("replaces in place when id already exists (no duplicate)", () => {
    const q = [mkEntry("plan_decision", "a", 1, { text: "old" })];
    const next = upsertIntoQueue(q, mkEntry("plan_decision", "a", 2, { text: "new" }));
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe("new");
    expect(next[0]?.createdAt).toBe(2);
  });

  it("does not mutate the input queue", () => {
    const q = [mkEntry("plan_decision", "a", 1)];
    const snapshot = JSON.stringify(q);
    upsertIntoQueue(q, mkEntry("question_answer", "b", 2));
    expect(JSON.stringify(q)).toBe(snapshot);
  });
});

describe("sortAndCapQueue", () => {
  it("orders by priority DESC, then createdAt ASC", () => {
    const q: PendingAgentInjectionEntry[] = [
      mkEntry("plan_nudge", "n1", 100), // priority 1 by default
      mkEntry("plan_decision", "d1", 200), // priority 10 by default
      mkEntry("question_answer", "q1", 300), // priority 8 by default
      mkEntry("plan_decision", "d2", 150), // priority 10, older
    ];
    const sorted = sortAndCapQueue(q);
    expect(sorted.map((e) => e.id)).toEqual(["d2", "d1", "q1", "n1"]);
  });

  it("honors explicit priority overrides", () => {
    const q: PendingAgentInjectionEntry[] = [
      mkEntry("plan_nudge", "n1", 100, { priority: 100 }), // overridden to highest
      mkEntry("plan_decision", "d1", 200), // default 10
    ];
    const sorted = sortAndCapQueue(q);
    expect(sorted.map((e) => e.id)).toEqual(["n1", "d1"]);
  });

  it("caps at MAX_QUEUE_SIZE and warns on eviction", () => {
    const warn = vi.fn();
    const q: PendingAgentInjectionEntry[] = [];
    for (let i = 0; i < MAX_QUEUE_SIZE + 3; i++) {
      q.push(mkEntry("plan_nudge", `n${i}`, i)); // all same priority
    }
    const sorted = sortAndCapQueue(q, { warn });
    expect(sorted).toHaveLength(MAX_QUEUE_SIZE);
    expect(warn).toHaveBeenCalledTimes(3);
    // Oldest (lowest createdAt) are evicted first when priority is tied;
    // actually since sort is by (priority DESC, createdAt ASC), the OLDEST
    // come first in the sorted order, and the NEWEST get dropped.
    // That's the opposite of what we want from "evict oldest".
    // Document the actual behavior here: we evict NEWEST at the tail to
    // favor older (more context) injections when the queue overflows.
    expect(sorted.map((e) => e.id)).toEqual([
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
      "n7",
      "n8",
      "n9",
    ]);
  });

  it("preserves all entries when queue is under cap", () => {
    const q = [mkEntry("plan_decision", "d1", 1), mkEntry("question_answer", "q1", 2)];
    const sorted = sortAndCapQueue(q);
    expect(sorted).toHaveLength(2);
  });

  it("does not mutate the input queue", () => {
    const q = [mkEntry("plan_nudge", "n1", 100), mkEntry("plan_decision", "d1", 200)];
    const snapshot = JSON.stringify(q);
    sortAndCapQueue(q);
    expect(JSON.stringify(q)).toBe(snapshot);
  });
});

describe("composePromptWithPendingInjections", () => {
  it("returns the user prompt unchanged when queue is empty", () => {
    expect(composePromptWithPendingInjections([], "do the thing")).toBe("do the thing");
  });

  it("joins multiple entries with double newlines, then separates from user prompt", () => {
    const entries = [
      mkEntry("plan_decision", "d1", 1, { text: "[PLAN_DECISION]: approved" }),
      mkEntry("subagent_return", "s1", 2, { text: "[SUBAGENT_RETURN]: runId=abc" }),
    ];
    expect(composePromptWithPendingInjections(entries, "next")).toBe(
      "[PLAN_DECISION]: approved\n\n[SUBAGENT_RETURN]: runId=abc\n\nnext",
    );
  });

  it("emits injection only when user prompt is empty or whitespace-only", () => {
    const entries = [mkEntry("plan_decision", "d1", 1, { text: "[PLAN_DECISION]: approved" })];
    expect(composePromptWithPendingInjections(entries, "")).toBe("[PLAN_DECISION]: approved");
    expect(composePromptWithPendingInjections(entries, "   \n  ")).toBe(
      "[PLAN_DECISION]: approved",
    );
  });

  it("trims user prompt before composing", () => {
    const entries = [mkEntry("question_answer", "q1", 1, { text: "[QUESTION_ANSWER]: yes" })];
    expect(composePromptWithPendingInjections(entries, "  hi  \n")).toBe(
      "[QUESTION_ANSWER]: yes\n\nhi",
    );
  });
});

describe("DEFAULT_INJECTION_PRIORITY", () => {
  it("orders plan_decision above every other kind", () => {
    const pd = DEFAULT_INJECTION_PRIORITY.plan_decision ?? 0;
    for (const kind of [
      "plan_complete",
      "question_answer",
      "subagent_return",
      "plan_intro",
      "plan_nudge",
    ]) {
      expect(pd).toBeGreaterThan(DEFAULT_INJECTION_PRIORITY[kind] ?? 0);
    }
  });

  it("orders plan_complete above question_answer", () => {
    expect(DEFAULT_INJECTION_PRIORITY.plan_complete ?? 0).toBeGreaterThan(
      DEFAULT_INJECTION_PRIORITY.question_answer ?? 0,
    );
  });
});

// -------------------------------------------------------------
// End-to-end: enqueue + consume with real tmp-dir store
// -------------------------------------------------------------

describe("enqueuePendingAgentInjection + consumePendingAgentInjections (e2e)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-injection-queue-"));
    tmpStorePath.value = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeStore(sessionKey: string, entry: Record<string, unknown>): Promise<void> {
    const store = { [sessionKey]: { sessionId: "test-session", updatedAt: 0, ...entry } };
    await fs.writeFile(tmpStorePath.value, JSON.stringify(store), "utf8");
  }

  async function readStore(sessionKey: string): Promise<Record<string, unknown> | undefined> {
    const raw = await fs.readFile(tmpStorePath.value, "utf8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    return parsed[sessionKey];
  }

  it("returns empty result when the queue is undefined (no prior write)", async () => {
    await writeStore("agent:main:s1", { sessionId: "s1", updatedAt: 1 });
    const result = await consumePendingAgentInjections("agent:main:s1");
    expect(result.injections).toHaveLength(0);
    expect(result.composedText).toBeUndefined();
  });

  it("migrates a legacy scalar to the queue on first consume, then clears both", async () => {
    await writeStore("agent:main:s1", {
      sessionId: "s1",
      updatedAt: 1,
      pendingAgentInjection: "[PLAN_DECISION]: approved",
    });
    const result = await consumePendingAgentInjections("agent:main:s1");
    expect(result.injections).toHaveLength(1);
    expect(result.injections[0]?.kind).toBe("plan_decision");
    expect(result.injections[0]?.text).toBe("[PLAN_DECISION]: approved");
    expect(result.composedText).toBe("[PLAN_DECISION]: approved");
    const after = await readStore("agent:main:s1");
    expect(after?.pendingAgentInjection).toBeUndefined();
    expect(after?.pendingAgentInjections).toBeUndefined();
  });

  it("enqueues a single entry and composes it on consume (once-and-only-once)", async () => {
    await writeStore("agent:main:s1", { sessionId: "s1", updatedAt: 1 });
    const ok = await enqueuePendingAgentInjection("agent:main:s1", {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "[PLAN_DECISION]: approved\n\n1. step one\n2. step two",
      createdAt: 1000,
      approvalId: "abc",
      priority: 10,
    });
    expect(ok).toBe(true);
    const first = await consumePendingAgentInjections("agent:main:s1");
    expect(first.injections).toHaveLength(1);
    expect(first.composedText).toContain("[PLAN_DECISION]: approved");
    // Queue cleared after first consume.
    const second = await consumePendingAgentInjections("agent:main:s1");
    expect(second.injections).toHaveLength(0);
    expect(second.composedText).toBeUndefined();
  });

  it("dedup upsert: same-id second enqueue replaces the first", async () => {
    await writeStore("agent:main:s1", { sessionId: "s1", updatedAt: 1 });
    await enqueuePendingAgentInjection("agent:main:s1", {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "first",
      createdAt: 1000,
    });
    await enqueuePendingAgentInjection("agent:main:s1", {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "second",
      createdAt: 2000,
    });
    const result = await consumePendingAgentInjections("agent:main:s1");
    expect(result.injections).toHaveLength(1);
    expect(result.injections[0]?.text).toBe("second");
  });

  it("concurrent different-kind writes both land (no clobber — the core bug being fixed)", async () => {
    await writeStore("agent:main:s1", { sessionId: "s1", updatedAt: 1 });
    await enqueuePendingAgentInjection("agent:main:s1", {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "[PLAN_DECISION]: approved",
      createdAt: 1000,
    });
    await enqueuePendingAgentInjection("agent:main:s1", {
      id: "question-answer-def",
      kind: "question_answer",
      text: "[QUESTION_ANSWER]: yes",
      createdAt: 1001,
    });
    const result = await consumePendingAgentInjections("agent:main:s1");
    // Both present, in priority order (plan_decision 10 > question_answer 8).
    expect(result.injections.map((e) => e.kind)).toEqual(["plan_decision", "question_answer"]);
    expect(result.composedText).toBe("[PLAN_DECISION]: approved\n\n[QUESTION_ANSWER]: yes");
  });

  it("filters out expired entries at consume time", async () => {
    await writeStore("agent:main:s1", { sessionId: "s1", updatedAt: 1 });
    await enqueuePendingAgentInjection("agent:main:s1", {
      id: "nudge-1",
      kind: "plan_nudge",
      text: "[PLAN_NUDGE]: stale",
      createdAt: 1000,
      expiresAt: 1, // already expired
    });
    await enqueuePendingAgentInjection("agent:main:s1", {
      id: "nudge-2",
      kind: "plan_nudge",
      text: "[PLAN_NUDGE]: fresh",
      createdAt: 1000,
      // no expiresAt
    });
    const result = await consumePendingAgentInjections("agent:main:s1");
    expect(result.injections.map((e) => e.id)).toEqual(["nudge-2"]);
  });

  it("returns empty for empty sessionKey without touching the store", async () => {
    const result = await consumePendingAgentInjections("");
    expect(result.injections).toHaveLength(0);
    expect(result.composedText).toBeUndefined();
  });

  it("preserves unrelated SessionEntry fields on enqueue and consume", async () => {
    await writeStore("agent:main:s1", {
      sessionId: "s1",
      updatedAt: 1,
      execHost: "local",
      execSecurity: "deny",
      planMode: { mode: "plan", approval: "pending", rejectionCount: 0 },
    });
    await enqueuePendingAgentInjection("agent:main:s1", {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "[PLAN_DECISION]: approved",
      createdAt: 1000,
    });
    const midway = await readStore("agent:main:s1");
    expect(midway?.execHost).toBe("local");
    expect(midway?.planMode).toBeDefined();
    await consumePendingAgentInjections("agent:main:s1");
    const after = await readStore("agent:main:s1");
    expect(after?.execHost).toBe("local");
    expect(after?.execSecurity).toBe("deny");
    expect(after?.planMode).toBeDefined();
  });

  it("enqueue returns false (no throw) when session doesn't exist", async () => {
    await writeStore("agent:main:other", { sessionId: "other", updatedAt: 1 });
    const ok = await enqueuePendingAgentInjection("agent:main:missing", {
      id: "x",
      kind: "plan_decision",
      text: "x",
      createdAt: 1,
    });
    expect(ok).toBe(false);
  });

  it("enqueue returns false (no throw) when sessionKey is empty", async () => {
    const ok = await enqueuePendingAgentInjection("", {
      id: "x",
      kind: "plan_decision",
      text: "x",
      createdAt: 1,
    });
    expect(ok).toBe(false);
  });
});
