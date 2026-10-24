import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import type { SessionEntry } from "../../src/config/sessions/types.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    turns: { type: "string", default: "100" },
    collected: { type: "boolean", default: false },
    "expect-released": { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Provide a fresh synthetic --state-dir");
assert(global.gc, "Run with --expose-gc");
const turns = Number(values.turns);
assert(Number.isSafeInteger(turns) && turns > 0);
const stateDir = path.resolve(values["state-dir"]);
await mkdir(stateDir, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { stageSessionPendingInput, bindSessionPendingInputSources } =
  await import("../../src/config/sessions/session-accessor.pending-inputs.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const scope = {
  agentId: "main",
  sessionKey: "agent:main:pending-retention",
  sessionId: "pending-retention",
  storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
};
setRuntimeConfigSnapshot({
  session: { store: scope.storePath },
  logging: { level: "silent", consoleLevel: "silent", file: path.join(stateDir, "run.log") },
});
await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
const bytes = serialize({
  sessionId: scope.sessionId,
  updatedAt: 1,
  skillsSnapshot: { prompt: "synthetic ".repeat(4096), skills: [] },
} satisfies SessionEntry);
const timers: NodeJS.Timeout[] = [];
const references: WeakRef<SessionEntry>[] = [];
// Created through the real receipt scope; the callback itself captures no turn data.
const makeTimer = () => setTimeout(() => {}, 3_600_000);
async function stageTurn(index: number) {
  const entry = deserialize(bytes) as SessionEntry;
  const runId = `synthetic-${index}`;
  const message = {
    role: "user" as const,
    content: "Synthetic input",
    timestamp: 1,
    idempotencyKey: `${runId}:user`,
  };
  const receipt = await stageSessionPendingInput(scope, {
    runId,
    message,
    assertCurrent: () => assert.equal(entry.sessionId, scope.sessionId),
  });
  assert(receipt);
  const execution = values.collected
    ? bindSessionPendingInputSources([receipt], {
        ...message,
        idempotencyKey: `${runId}:collected`,
      })
    : receipt;
  assert(execution);
  timers.push(execution.run(makeTimer));
  return { receipt: execution, reference: new WeakRef(entry) };
}
async function settledTurn(index: number) {
  const { receipt, reference } = await stageTurn(index);
  receipt.finish("cancelled");
  await receipt.settled?.();
  assert.throws(() => receipt.run(() => {}), /ownership ended/);
  references.push(reference);
}
async function collect() {
  for (let i = 0; i < 4; i++) {
    await nextTurn();
    global.gc!();
  }
}
const survivors = () => references.filter((reference) => reference.deref()).length;
try {
  await settledTurn(-1);
  timers.splice(0).forEach(clearTimeout);
  references.length = 0;
  await collect();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < turns; i++) {
    await settledTurn(i);
  }
  await collect();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  const retainedEntries = survivors();
  assert.equal(timers.filter((timer) => timer.hasRef()).length, turns);
  timers.splice(0).forEach(clearTimeout);
  await collect();
  const afterClearEntries = survivors();
  console.log(
    JSON.stringify({
      node: process.version,
      turns,
      collected: values.collected,
      pendingTimers: turns,
      payloadBytes: bytes.byteLength,
      retainedEntries,
      retainedBytes,
      afterClearEntries,
    }),
  );
  assert.equal(afterClearEntries, 0, "Cleared timers must release the entries");
  if (values["expect-released"]) {
    assert.equal(retainedEntries, 0, "Settled timer contexts retained session entries");
  }
} finally {
  timers.splice(0).forEach(clearTimeout);
  await closeOpenClawAgentDatabasesAsync();
  clearRuntimeConfigSnapshot();
}
