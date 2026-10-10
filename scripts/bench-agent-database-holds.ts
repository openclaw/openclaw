// Synthetic before/after proof; run outside per-PR tests with scripts/tsx.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { readMainSessionRecoveryCheckpoint } from "../src/agents/main-session-recovery/main-session-restart-recovery-checkpoint.js";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import {
  replaceTranscriptEvents,
  replaceSessionEntry,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import type { TranscriptEvent } from "../src/config/sessions/session-accessor.sqlite-contract.js";
import { writeSessionEntry } from "../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { recoverSessionEntryFromRestartTombstone } from "../src/config/sessions/session-accessor.sqlite-recovery.js";
import { waitForSessionTranscriptProjection } from "../src/config/sessions/session-transcript-reconcile.js";
import type { InternalSessionEntry } from "../src/config/sessions/types.js";
import { readLatestSessionUsageFromTranscriptAsync } from "../src/gateway/session-transcript-usage.js";
import { runOpenClawAgentWriteTransaction } from "../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const messages = Number(process.argv[2] ?? 10_000);
const sessions = Number(process.argv[3] ?? 2_000);
assert(Number.isSafeInteger(messages) && messages > 0);
assert(Number.isSafeInteger(sessions) && sessions > 0);

async function measure(name: string, run: () => Promise<unknown>) {
  let queries = 0;
  let holds = 0;
  let holdMs = 0;
  let startedHold: number | undefined;
  let maxLoopGapMs = 0;
  const sampling = new AbortController();
  const sampler = (async () => {
    while (!sampling.signal.aborted) {
      const start = performance.now();
      await yieldTurn();
      maxLoopGapMs = Math.max(maxLoopGapMs, performance.now() - start);
    }
  })();
  // Retain typed native descriptors so the wrappers preserve receivers and restore every flag.
  const databaseMethods = Object.getOwnPropertyDescriptors(DatabaseSync.prototype);
  const statementMethods = Object.getOwnPropertyDescriptors(StatementSync.prototype);
  const originalExec = databaseMethods.exec.value;
  const originalGet = statementMethods.get.value;
  const originalAll = statementMethods.all.value;
  const originalIterate = statementMethods.iterate.value;
  assert(originalExec && originalGet && originalAll && originalIterate);
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (/^BEGIN\b/i.test(sql)) {
      holds++;
      startedHold = performance.now();
    } else if (/^(COMMIT|ROLLBACK)\b/i.test(sql) && startedHold !== undefined) {
      holdMs += performance.now() - startedHold;
      startedHold = undefined;
    }
    return result;
  };
  // The native query methods are overloaded (named or anonymous parameters); forward the
  // caller's argument list untouched instead of narrowing it to one overload.
  StatementSync.prototype.get = function (...args) {
    queries++;
    return Reflect.apply(originalGet, this, args);
  };
  StatementSync.prototype.all = function (...args) {
    queries++;
    return Reflect.apply(originalAll, this, args);
  };
  StatementSync.prototype.iterate = function (...args) {
    queries++;
    return Reflect.apply(originalIterate, this, args);
  };
  const start = performance.now();
  try {
    await run();
  } finally {
    const wallMs = performance.now() - start;
    Object.defineProperty(DatabaseSync.prototype, "exec", databaseMethods.exec);
    Object.defineProperty(StatementSync.prototype, "get", statementMethods.get);
    Object.defineProperty(StatementSync.prototype, "all", statementMethods.all);
    Object.defineProperty(StatementSync.prototype, "iterate", statementMethods.iterate);
    await yieldTurn();
    sampling.abort();
    await sampler;
    console.log(
      JSON.stringify({
        name,
        wallMs,
        mainQueries: queries,
        mainHolds: holds,
        mainHoldMs: holdMs,
        maxLoopGapMs,
        maxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
}

await withOpenClawTestState({ label: "agent-database-holds" }, async (state) => {
  const scope = {
    agentId: "main",
    sessionId: "large-transcript",
    sessionKey: "agent:main:large-transcript",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  const databasePath = resolveSessionTranscriptDatabasePath(scope);
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < sessions; index++) {
        writeSessionEntry(database, `agent:main:unrelated-${index}`, {
          sessionId: `unrelated-${index}`,
          updatedAt: 1,
        });
      }
    },
    { agentId: "main", path: databasePath },
  );
  const events: TranscriptEvent[] = [{ type: "session", version: 3, id: scope.sessionId }];
  for (let index = 0; index < messages; index++) {
    const text = Array.from({ length: 64 }, (_, part) =>
      createHash("sha256").update(`synthetic-${index}-${part}`).digest("hex"),
    ).join("");
    events.push({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message: {
        role: index % 2 ? "assistant" : "user",
        content: text,
        ...(index % 2 ? { usage: { input: 100, output: 10, totalTokens: 110 } } : {}),
      },
    });
  }
  await replaceTranscriptEvents(scope, events);
  await waitForSessionTranscriptProjection(scope);
  events.length = 0;
  console.log(
    JSON.stringify({
      messages,
      sessions,
      payloadBytesPerMessage: 4096,
      databaseBytes: fs.statSync(databasePath).size,
      walBytes: fs.existsSync(`${databasePath}-wal`) ? fs.statSync(`${databasePath}-wal`).size : 0,
      node: process.version,
    }),
  );
  // Admit readers before comparing steady-state scans.
  await readMainSessionRecoveryCheckpoint(scope);
  await readLatestSessionUsageFromTranscriptAsync(scope);
  for (let sample = 0; sample < 3; sample++) {
    await measure(`recovery-checkpoint-${sample}`, () => readMainSessionRecoveryCheckpoint(scope));
    await measure(`usage-${sample}`, () => readLatestSessionUsageFromTranscriptAsync(scope));
  }
  const manager = await SessionManager.openAsync(scope, state.workspaceDir);
  for (let sample = 0; sample < 3; sample++) {
    await measure(`custom-message-append-${sample}`, () =>
      manager.appendMessageAsync({
        role: "custom",
        customType: "synthetic-notice",
        content: "benchmark notice",
        display: false,
        timestamp: Date.now(),
      }),
    );
  }
  const recoveryEntry: InternalSessionEntry = {
    sessionId: scope.sessionId,
    updatedAt: Date.now(),
    mainRestartRecovery: {
      cycleId: "synthetic-cycle",
      revision: 1,
      chargedAttempts: 3,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  };
  await replaceSessionEntry(scope, recoveryEntry);
  await measure("recover-tombstone", async () => {
    const successorKey = "agent:main:recovered";
    const result = await recoverSessionEntryFromRestartTombstone({
      agentId: scope.agentId,
      storePath: scope.storePath,
      expected: { cycleId: "synthetic-cycle", revision: 1, sessionId: scope.sessionId },
      sourceTarget: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      successorTarget: { canonicalKey: successorKey, storeKeys: [successorKey] },
      successorEntry: { sessionId: "recovered", updatedAt: Date.now() },
    });
    assert.equal(result.status, "created");
  });
});
