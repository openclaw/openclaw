import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

// Run on an idle benchmark host; --check enforces the 50 ms main-thread budget.
// node --import ./scripts/tsx.mjs scripts/bench-session-manager-rewrite.ts --check
await withOpenClawTestState({ label: "session-rewrite" }, async (state) => {
  const scope = {
    agentId: "main",
    sessionId: "rewrite",
    sessionKey: "agent:main:rewrite",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = await SessionManager.openAsync(scope);
  const append = async (target: SessionManager) => {
    const id = await target.appendMessageAsync({
      role: "user",
      content: "synthetic rewrite",
      timestamp: 1,
    });
    assert.ok(id, "Synthetic message must be appended");
    return id;
  };
  let source = await append(manager);
  const rewrite = async () => {
    const started = performance.now();
    const prepared = await manager.prepareTranscriptRewriteAsync();
    const prepareMs = performance.now() - started;
    await prepared.sessionManager.resetLeafAsync();
    const replacement = await append(prepared.sessionManager);
    const commitStarted = performance.now();
    await prepared.commit(new Map([[source, replacement]]));
    source = replacement;
    return { prepareMs, commitMs: performance.now() - commitStarted };
  };
  await rewrite();
  const payloadBytes = 50 * 1024 * 1024;
  await manager.appendCustomEntryAsync("synthetic-payload", { text: "x".repeat(payloadBytes) });
  source = await append(manager);
  const samples = [];
  for (let index = 0; index < 5; index++) {
    await delay(10);
    let previous = performance.now();
    let maxStallMs = 0;
    let heartbeat: NodeJS.Immediate;
    const observe = () => {
      const now = performance.now();
      maxStallMs = Math.max(maxStallMs, now - previous);
      previous = now;
      heartbeat = setImmediate(observe);
    };
    heartbeat = setImmediate(observe);
    try {
      const timing = await rewrite();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      samples.push({ ...timing, maxStallMs });
    } finally {
      clearImmediate(heartbeat);
    }
  }
  const durable = await loadTranscriptEvents(scope);
  const payload = durable.find(
    (entry) =>
      isRecord(entry) && entry.type === "custom" && entry.customType === "synthetic-payload",
  );
  assert.ok(isRecord(payload) && isRecord(payload.data));
  assert.equal(payload.data.text, "x".repeat(payloadBytes));
  assert.equal((await SessionManager.openAsync(scope)).getLeafId(), source);
  console.log(JSON.stringify({ node: process.version, payloadBytes, samples, durable: true }));
  if (process.argv.includes("--check")) {
    assert.ok(
      samples.every((sample) => sample.maxStallMs < 50),
      "Rewrite exceeded 50 ms stall budget",
    );
  }
});
