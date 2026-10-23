/* oxlint-disable unicorn/require-post-message-target-origin -- Node BroadcastChannel has no targetOrigin argument. */
// NODE_OPTIONS="--import=$(pwd)/extensions/copilot/test/journal-allocation-probe.mjs" \
// node --import ./scripts/tsx.mjs extensions/copilot/test/bench-attempt-transcript-journal.ts --history-mib 1
// Run baseline/candidate serially, interleaved. Isolated synthetic state only; no provider calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { BroadcastChannel } from "node:worker_threads";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessagesByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createAttemptTranscriptJournal } from "../src/attempt-transcript-journal.js";
import type { AttemptParamsLike } from "../src/attempt-types.js";

const { values } = parseArgs({ options: { "history-mib": { type: "string", default: "1" } } });
const historyBytes = Number(values["history-mib"]) * 1024 * 1024;
assert([0.25, 1, 4].includes(Number(values["history-mib"])));
assert(process.env.OPENCLAW_STATE_DIR, "Set OPENCLAW_STATE_DIR to isolated benchmark state");
assert(process.env.NODE_OPTIONS?.includes("journal-allocation-probe.mjs"), "Load allocation probe");
const target = {
  agentId: "main",
  sessionId: "journal-benchmark",
  sessionKey: "agent:main:journal-benchmark",
  storePath: path.join(process.env.OPENCLAW_STATE_DIR, "agents/main/sessions/sessions.json"),
};
const channel = new BroadcastChannel(`copilot-journal-${process.pid}`);
const threads = new Set<number>();
type Measurement = {
  threadId: number;
  allocatedBytes: number;
  historyDecodeBytes: number;
  historyDecodes: number;
};
let receive: (data: Measurement & { kind: string }) => void = () => {};
channel.addEventListener("message", ({ data }) => {
  if (data.kind === "ready") {
    threads.add(data.threadId);
  }
  receive(data);
});
async function command(instruction: string, kind: string): Promise<Measurement[]> {
  const remaining = new Set(threads);
  const results: Measurement[] = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Missing ${kind}: ${[...remaining].join(", ")}`)),
      30_000,
    );
    receive = (data) => {
      if (data.kind === kind && remaining.delete(data.threadId)) {
        results.push(data);
        if (remaining.size === 0) {
          clearTimeout(timeout);
          resolve(results);
        }
      }
    };
    channel.postMessage({ command: instruction });
  });
}
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function groups(prefix: string, count: number) {
  // Only transcript target/run identity is consumed; no provider/harness execution occurs.
  const attempt = { sessionTarget: target, agentId: "main", runId: prefix } as AttemptParamsLike;
  const journal = createAttemptTranscriptJournal({
    abortSession: async () => {},
    attempt,
    messages: [],
    sdkSessionId: "benchmark",
  });
  const timings: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    const start = performance.now();
    journal.recordAssistant({
      eventId: `assistant-${id}`,
      toolCallIds: [id],
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "read", arguments: {} }],
        api: "openai-responses",
        provider: "github-copilot",
        model: "fixture",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
    });
    journal.recordToolResult({
      eventId: `result-${id}`,
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 2,
      },
    });
    await journal.barrier("benchmark group");
    timings.push(performance.now() - start);
  }
  assert.equal(journal.snapshot().messagesSnapshot.length, count * 2);
  return timings;
}
try {
  await fs.mkdir(path.dirname(target.storePath), { recursive: true });
  await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
  const content = `copilot-bench-history:${"x".repeat(4096)}`;
  await appendSessionTranscriptMessagesByIdentity({
    ...target,
    messages: Array.from({ length: Math.ceil(historyBytes / content.length) }, (_, i) => ({
      eventId: `history-${i}`,
      message: { role: "user", content, timestamp: 0 } satisfies AgentMessage,
    })),
  });
  await groups("warmup", 1);
  await groups("warmup", 1); // Warm duplicate replay as well as fresh append.
  await readVisibleSessionTranscriptMessageEntries(target); // Warm both read/write workers.
  channel.postMessage({ command: "discover" });
  // Discovery happens only outside the measurement; let all already-warmed workers answer.
  await new Promise((resolve) => {
    setTimeout(resolve, 1000);
  });
  assert(threads.has(0) && threads.size > 1, "Main and SQLite worker probes must respond");
  const measurements = [];
  for (const mode of ["fresh", "replay"]) {
    await command("start", "started");
    const timings = await groups("measured", 10);
    const perThread = await command("stop", "stopped");
    measurements.push({ mode, timings, perThread });
  }
  console.log(JSON.stringify({ historyBytes, groups: 10, measurements }));
} finally {
  channel.close();
  await closeOpenClawAgentDatabasesAsync(process.env.OPENCLAW_STATE_DIR);
  await closeOpenClawStateDatabaseAsync();
}
