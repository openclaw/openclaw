import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  prepareSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
} from "../embedded-agent-runner/session-prompt-state.js";
import type { SessionEntry } from "./session-manager-types.js";
import { SessionManager } from "./session-manager.js";
import { shareSessionSystemPrompt, shareSystemPromptPrefix } from "./system-prompt-pool.js";

const MIB = 1024 * 1024;
const prompt = ("## Synthetic instructions\n" + "Keep every byte.\n".repeat(8000)).slice(0, 131072);
const checkpoint = {
  prefix: prompt,
  renderedPrefix: prompt,
  hash: "synthetic-digest",
  routeKey: "synthetic/model",
  historyId: null,
  restart: true,
};
const custom = <T>(id: string, customType: string, data: T) => ({
  type: "custom" as const,
  customType,
  id,
  parentId: null,
  timestamp: "2026-10-01T00:00:00Z",
  data,
});
const collect = () => {
  global.gc!();
  global.gc!();
};

function createSession(index: number, restored: boolean) {
  if (restored) {
    return SessionManager.fromEntries([
      { type: "session", version: 4, id: `prefix-${index}`, cwd: "/synthetic" },
      custom("checkpoint", "openclaw.system-prompt", checkpoint),
    ]);
  }
  const manager = SessionManager.inMemory("/synthetic");
  manager.appendCustomEntry("openclaw.system-prompt", { ...checkpoint });
  return manager;
}

assert.equal(typeof global.gc, "function");
for (const restored of [false, true]) {
  createSession(-1, restored);
  collect();
  const before = process.memoryUsage().heapUsed;
  const sessions = Array.from({ length: 50 }, (_, index) => createSession(index, restored));
  collect();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  console.log(JSON.stringify({ restored, sessions: sessions.length, retainedBytes }));
  assert.ok(retainedBytes < 2 * MIB, `prompt checkpoints retained ${retainedBytes} bytes`);
  for (const session of sessions) {
    const entry = session.getBranch().at(-1);
    assert.equal(entry?.type, "custom");
    if (entry?.type === "custom") {
      assert.deepEqual(entry.data, checkpoint);
    }
  }
}

// Interleaved loads must not retain a fresh copy each time the prompt working set rotates.
async function assertInterleavedCheckpointRetention() {
  await drainGlobalSingletonLifecycleState();
  await setImmediate();
  global.gc!();
  const before = process.memoryUsage().heapUsed;
  function checkpointFor(index: number) {
    const text = `Synthetic checkpoint ${index}: `.padEnd(128 * 1024, "x");
    return shareSessionSystemPrompt(
      structuredClone(
        custom(`checkpoint-${index}`, "openclaw.system-prompt", {
          prefix: text,
          renderedPrefix: text,
        }),
      ),
    );
  }
  const checkpoints = Array.from({ length: 3 }, () =>
    Array.from({ length: 80 }, (_, index) => checkpointFor(index)),
  );
  await setImmediate();
  collect();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  console.log(JSON.stringify({ workingSet: 80, cohorts: checkpoints.length, retainedBytes }));
  assert.ok(retainedBytes < 14 * MIB, `interleaved checkpoints retained ${retainedBytes} bytes`);
  for (const cohort of checkpoints) {
    for (const [index, entry] of cohort.entries()) {
      const expected = `Synthetic checkpoint ${index}: `.padEnd(128 * 1024, "x");
      assert.equal(entry.data.prefix, expected);
      assert.equal(entry.data.renderedPrefix, expected);
    }
  }
}
await assertInterleavedCheckpointRetention();
await drainGlobalSingletonLifecycleState();

// Retained admission callbacks need the prompt series, not the history used to restore it.
function prepareRetainedAdmission() {
  const lease = retainEmbeddedSessionPromptState("retained-admission");
  const entries: SessionEntry[] = [
    custom("history", "synthetic-history", { text: "Historical payload" }),
  ];
  return {
    lease,
    history: new WeakRef(entries),
    prepared: prepareSessionSystemPrompt({
      state: lease.state,
      routeKey: "synthetic/model",
      systemPrompt: prompt,
      entries,
    }),
  };
}

const admission = prepareRetainedAdmission();
await setImmediate();
global.gc!();
assert.equal(admission.history.deref(), undefined, "admission retained the transcript history");
admission.prepared.commit();
assert.equal(admission.prepared.systemPrompt, prompt);
admission.lease[Symbol.dispose]();

// Exact UTF-16 keys preserve distinct strings that UTF-8 hashes collapse.
for (const suffix of ["\ud800", "\ud801", "\ufffd", "\ud800"]) {
  const text = "Synthetic Unicode prompt. ".repeat(100) + suffix;
  assert.equal(shareSystemPromptPrefix(text), text);
}

// Promoting a hit must keep the owned key, not the caller's much larger backing string.
await drainGlobalSingletonLifecycleState();
shareSystemPromptPrefix("x".repeat(128 * 1024));
await setImmediate();
collect();
const beforeSliceHit = process.memoryUsage().heapUsed;
function shareSlice() {
  return shareSystemPromptPrefix(
    Buffer.alloc(8 * MIB, 120)
      .toString("ascii")
      .slice(0, 128 * 1024),
  );
}
const sharedSlice = shareSlice();
await setImmediate();
collect();
assert.equal(sharedSlice.length, 128 * 1024);
assert.ok(
  process.memoryUsage().heapUsed - beforeSliceHit < MIB,
  "Pool retained a caller's backing string",
);
