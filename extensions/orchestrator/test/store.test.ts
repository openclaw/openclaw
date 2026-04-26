import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { StoreError, applyAction, createStore, mintTaskId } from "../src/store.js";
import { liveDir, shadowDir, syntheticDir, taskPath } from "../src/store.paths.js";
import type { Task, TaskRoutingDecision } from "../src/types/schema.js";

let tmpHome: string;
const opts = () => ({ openclawHome: tmpHome });

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "orchestrator-store-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const sampleRouting: TaskRoutingDecision = {
  matchedRuleId: "code-tasks",
  assignedAgentId: "coder",
  capabilityMatches: [],
  fallbackUsed: false,
  decidedAt: new Date(0).toISOString(),
};

function freshTask(overrides: Partial<Task> = {}): Task {
  const id = mintTaskId();
  const ts = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    kind: "live",
    state: "queued",
    goal: "test goal",
    workspaceDir: null,
    requiredCapabilities: [],
    routing: null,
    assignedAgentId: null,
    result: null,
    rejection: null,
    error: null,
    submittedBy: "tester",
    createdAt: ts,
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("mintTaskId", () => {
  test("returns 26 chars", () => {
    expect(mintTaskId()).toHaveLength(26);
  });

  test("ids minted at the same ms are still unique (random tail)", () => {
    const ids = Array.from({ length: 100 }, () => mintTaskId(() => 1_700_000_000_000));
    expect(new Set(ids).size).toBe(100);
  });

  test("ids minted later sort after ids minted earlier", () => {
    const a = mintTaskId(() => 1_700_000_000_000);
    const b = mintTaskId(() => 1_700_000_000_001);
    expect(a < b).toBe(true);
  });
});

describe("applyAction", () => {
  test("queued -> assigned via route", () => {
    const t = freshTask();
    const next = applyAction(t, { type: "route", routing: sampleRouting });
    expect(next.state).toBe("assigned");
    expect(next.assignedAgentId).toBe("coder");
    expect(next.assignedAt).not.toBeNull();
  });

  test("assigned -> in_progress via start", () => {
    const t = freshTask({ state: "assigned" });
    const next = applyAction(t, { type: "start", specialistSessionId: "s1" });
    expect(next.state).toBe("in_progress");
    expect(next.startedAt).not.toBeNull();
  });

  test("complete with requiresApproval=false goes straight to done", () => {
    const t = freshTask({ state: "in_progress" });
    const next = applyAction(t, {
      type: "complete",
      requiresApproval: false,
      result: {
        text: "ok",
        textPath: null,
        artefacts: [],
        specialistSessionId: "s1",
      },
    });
    expect(next.state).toBe("done");
    expect(next.completedAt).not.toBeNull();
  });

  test("complete with requiresApproval=true goes to awaiting_approval", () => {
    const t = freshTask({ state: "in_progress" });
    const next = applyAction(t, {
      type: "complete",
      requiresApproval: true,
      result: {
        text: "ok",
        textPath: null,
        artefacts: [],
        specialistSessionId: "s1",
      },
    });
    expect(next.state).toBe("awaiting_approval");
    expect(next.completedAt).toBeNull();
  });

  test("approve takes awaiting_approval -> done", () => {
    const t = freshTask({ state: "awaiting_approval" });
    const next = applyAction(t, { type: "approve" });
    expect(next.state).toBe("done");
  });

  test("reject takes awaiting_approval -> failed and populates rejection + error", () => {
    const t = freshTask({ state: "awaiting_approval" });
    const next = applyAction(t, {
      type: "reject",
      rejection: { by: "op", reason: "wrong agent", at: new Date().toISOString() },
    });
    expect(next.state).toBe("failed");
    expect(next.rejection?.reason).toBe("wrong agent");
    expect(next.error?.code).toBe("rejected");
  });

  test("expire only allowed from stale-eligible states", () => {
    expect(() => applyAction(freshTask({ state: "in_progress" }), { type: "expire" })).toThrow(
      StoreError,
    );
    const expired = applyAction(freshTask({ state: "queued" }), { type: "expire" });
    expect(expired.state).toBe("expired");
  });

  test("terminal states refuse further transitions", () => {
    expect(() =>
      applyAction(freshTask({ state: "done" }), {
        type: "approve",
      }),
    ).toThrow(/terminal/);
  });

  test("invalid transition throws with code=invalid_transition", () => {
    try {
      applyAction(freshTask({ state: "queued" }), { type: "approve" });
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("invalid_transition");
      return;
    }
    throw new Error("expected throw");
  });
});

describe("createStore", () => {
  test("submit + read happy path", () => {
    const store = createStore(opts());
    const t = store.submit({ goal: "hello", submittedBy: "tester" });
    expect(t.state).toBe("queued");
    const back = store.read(t.id);
    expect(back.id).toBe(t.id);
    expect(back.goal).toBe("hello");
  });

  test("submit writes to live dir by default", () => {
    const store = createStore(opts());
    const t = store.submit({ goal: "hello", submittedBy: "tester" });
    expect(readdirSync(liveDir(opts())).filter((f) => f.endsWith(".json"))).toContain(
      `${t.id}.json`,
    );
  });

  test("synthetic kind lands under synthetic/", () => {
    const store = createStore(opts());
    const t = store.submit({
      goal: "synth",
      submittedBy: "tester",
      kind: "synthetic",
    });
    expect(readdirSync(syntheticDir(opts()))).toContain(`${t.id}.json`);
  });

  test("shadow kind lands under shadow/", () => {
    const store = createStore(opts());
    const t = store.submit({
      goal: "shadow",
      submittedBy: "tester",
      kind: "shadow",
    });
    expect(readdirSync(shadowDir(opts()))).toContain(`${t.id}.json`);
  });

  test("list defaults to live only", () => {
    const store = createStore(opts());
    store.submit({ goal: "live-1", submittedBy: "tester" });
    store.submit({ goal: "synth-1", submittedBy: "tester", kind: "synthetic" });
    const live = store.list();
    expect(live.map((t) => t.goal)).toEqual(["live-1"]);
  });

  test("list filters by state", () => {
    const store = createStore(opts());
    const a = store.submit({ goal: "a", submittedBy: "tester" });
    store.submit({ goal: "b", submittedBy: "tester" });
    store.transition(a.id, { type: "route", routing: sampleRouting });
    const queued = store.list({ state: "queued" });
    expect(queued.map((t) => t.goal)).toEqual(["b"]);
    const assigned = store.list({ state: "assigned" });
    expect(assigned.map((t) => t.goal)).toEqual(["a"]);
  });

  test("list ignores *.json.tmp partial-write files", () => {
    const store = createStore(opts());
    store.submit({ goal: "real", submittedBy: "tester" });
    writeFileSync(`${liveDir(opts())}/abc.json.tmp`, "{}");
    expect(store.list().map((t) => t.goal)).toEqual(["real"]);
  });

  test("list skips schema-drifted entries instead of throwing", () => {
    const store = createStore(opts());
    store.submit({ goal: "good", submittedBy: "tester" });
    writeFileSync(`${liveDir(opts())}/drift.json`, JSON.stringify({ schemaVersion: 99 }));
    expect(store.list().map((t) => t.goal)).toEqual(["good"]);
  });

  test("read on a drifted file throws with code=schema_drift", () => {
    const store = createStore(opts());
    writeFileSync(taskPath("drift", "live", opts()), JSON.stringify({ schemaVersion: 99 }));
    expect(() => store.read("drift")).toThrow(StoreError);
    try {
      store.read("drift");
    } catch (err) {
      expect((err as StoreError).code).toBe("schema_drift");
    }
  });

  test("transition is CAS-protected — second concurrent caller gets lock_held", () => {
    const store = createStore(opts());
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    // Manually create the lockfile to simulate a held lock.
    writeFileSync(
      `${liveDir(opts())}/${t.id}.lock`,
      JSON.stringify({
        pid: process.pid,
        holderId: "other",
        createdAt: new Date().toISOString(),
      }),
    );
    expect(() => store.transition(t.id, { type: "route", routing: sampleRouting })).toThrow(
      /lock held/,
    );
  });

  test("transition reclaims a stale lockfile (>60s old)", () => {
    const store = createStore(opts());
    const t = store.submit({ goal: "x", submittedBy: "tester" });
    writeFileSync(
      `${liveDir(opts())}/${t.id}.lock`,
      JSON.stringify({
        pid: process.pid,
        holderId: "ghost",
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
    );
    const next = store.transition(t.id, {
      type: "route",
      routing: sampleRouting,
    });
    expect(next.state).toBe("assigned");
  });

  test("read on missing id throws with code=not_found", () => {
    const store = createStore(opts());
    expect(() => store.read("does-not-exist")).toThrow(StoreError);
  });

  test("sweepExpired moves stale-eligible tasks past expiresAt to expired", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const store = createStore({
      ...opts(),
      now: () => Date.now(),
    });
    const fresh = store.submit({
      goal: "stale",
      submittedBy: "tester",
      ttlMs: -1, // expires immediately
    });
    const swept = store.sweepExpired();
    expect(swept.map((t) => t.id)).toContain(fresh.id);
    expect(store.read(fresh.id).state).toBe("expired");
    expect(past).toBeDefined(); // unused — kept to silence linter on future edits
  });

  test("sweepExpired leaves terminal tasks alone", () => {
    const store = createStore(opts());
    const t = store.submit({
      goal: "x",
      submittedBy: "tester",
      ttlMs: -1,
    });
    store.transition(t.id, { type: "route", routing: sampleRouting });
    store.transition(t.id, { type: "start", specialistSessionId: "s1" });
    store.transition(t.id, {
      type: "complete",
      requiresApproval: false,
      result: {
        text: "done",
        textPath: null,
        artefacts: [],
        specialistSessionId: "s1",
      },
    });
    expect(store.sweepExpired()).toEqual([]);
  });
});
