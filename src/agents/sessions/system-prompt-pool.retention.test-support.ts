import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";

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

function createSession(index: number, restored: boolean) {
  if (restored) {
    return SessionManager.fromEntries([
      { type: "session", version: 4, id: `prefix-${index}`, cwd: "/synthetic" },
      {
        type: "custom",
        customType: "openclaw.system-prompt",
        id: "checkpoint",
        parentId: null,
        timestamp: "2026-10-01T00:00:00Z",
        data: checkpoint,
      },
    ]);
  }
  const manager = SessionManager.inMemory("/synthetic");
  manager.appendCustomEntry("openclaw.system-prompt", { ...checkpoint });
  return manager;
}

assert.equal(typeof global.gc, "function");
for (const restored of [false, true]) {
  createSession(-1, restored);
  global.gc!();
  global.gc!();
  const before = process.memoryUsage().heapUsed;
  const sessions = Array.from({ length: 50 }, (_, index) => createSession(index, restored));
  global.gc!();
  global.gc!();
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
