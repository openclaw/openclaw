import assert from "node:assert/strict";
import path from "node:path";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { createZeroUsageFixture } from "../src/agents/test-helpers/usage-fixtures.js";
import {
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

// node --import ./scripts/tsx.mjs scripts/bench-session-manager-write-hold.ts
await withOpenClawTestState({ label: "session-write-hold" }, async (state) => {
  const scope = {
    agentId: "main",
    sessionId: "write-hold",
    sessionKey: "agent:main:write-hold",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, state.workspaceDir);
  manager.appendMessage({ role: "user", content: "Explain this code", timestamp: 1 });
  const { db } = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const text = "```ts\nconst example = { label: 'synthetic', count: 42 };\n```\n"
    .repeat(4000)
    .slice(0, 200 * 1024);
  const samples: Array<{
    totalMs: number;
    holdMs: number;
    commitMs: number;
    jsonInHoldMs: number;
  }> = [];
  const exec = db.exec.bind(db);
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  let holdStart: number | undefined;
  let holdMs = 0;
  let commitMs = 0;
  let jsonInHoldMs = 0;
  db.exec = (sql) => {
    const finishing = (sql === "COMMIT" || sql === "ROLLBACK") && holdStart !== undefined;
    if (finishing && holdStart !== undefined) {
      holdMs += performance.now() - holdStart;
      holdStart = undefined;
    }
    const start = performance.now();
    exec(sql);
    if (sql === "BEGIN IMMEDIATE") {
      holdStart = performance.now();
    } else if (finishing) {
      commitMs += performance.now() - start;
    }
  };
  JSON.stringify = new Proxy(stringify, {
    apply(target, receiver, args) {
      const start = performance.now();
      const held = holdStart !== undefined;
      try {
        return Reflect.apply(target, receiver, args);
      } finally {
        if (held) {
          jsonInHoldMs += performance.now() - start;
        }
      }
    },
  });
  JSON.parse = (...args: Parameters<typeof parse>) => {
    const start = performance.now();
    const held = holdStart !== undefined;
    try {
      return parse(...args);
    } finally {
      if (held) {
        jsonInHoldMs += performance.now() - start;
      }
    }
  };
  try {
    for (let index = 0; index < 60; index += 1) {
      holdMs = 0;
      commitMs = 0;
      jsonInHoldMs = 0;
      const start = performance.now();
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "messages",
        provider: "anthropic",
        model: "sonnet-4.6",
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: index + 2,
      });
      const totalMs = performance.now() - start;
      if (index >= 10) {
        samples.push({ totalMs, holdMs, commitMs, jsonInHoldMs });
      }
    }
  } finally {
    db.exec = exec;
    JSON.stringify = stringify;
    JSON.parse = parse;
  }
  assert.equal(loadTranscriptEventsSync(scope).length, 62);
  const summary = (key: keyof (typeof samples)[number]) => {
    const values = samples.map((sample) => sample[key]).toSorted((a, b) => a - b);
    return { median: values[25], p95: values[47], max: values.at(-1) };
  };
  console.log(
    JSON.stringify(
      {
        node: process.version,
        payloadBytes: Buffer.byteLength(text),
        samples: samples.length,
        totalMs: summary("totalMs"),
        holdMs: summary("holdMs"),
        commitMs: summary("commitMs"),
        jsonInHoldMs: summary("jsonInHoldMs"),
        maxRssKiB: process.resourceUsage().maxRSS,
      },
      null,
      2,
    ),
  );
});
