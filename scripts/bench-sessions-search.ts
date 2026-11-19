// Synthetic search owner benchmark; node --import ./scripts/tsx.mjs scripts/bench-sessions-search.ts [sessions] [messages] [words] [samples]
// Acceptance: identical hits; lower warm solo and six-request completion median/p95;
// no additional main-thread production SQL. Compare identical fresh fixtures, five samples per arm.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StatementSync, type SQLInputValue } from "node:sqlite";
import { replaceSqliteTranscriptEventsInTransaction } from "../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import { appendTranscriptMessage } from "../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionTranscriptIndexStatus } from "../src/config/sessions/session-transcript-projection-writer.js";
import { waitForSessionTranscriptIndexReconcile } from "../src/config/sessions/session-transcript-reconcile.js";
import { searchSessionTranscripts } from "../src/config/sessions/session-transcript-search.js";
import { searchSessionTranscriptsFiltered } from "../src/config/sessions/session-transcript-search.worker.js";
import { transcriptSearchLane } from "../src/config/sessions/session-transcript-worker-resources.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../src/state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../src/state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const [sessions = 1000, messages = 20, words = 1000, samples = 5] = process.argv
  .slice(2)
  .map(Number);
assert(
  [sessions, messages, words, samples].every((value) => Number.isSafeInteger(value) && value > 0),
);
const root = path.resolve(".artifacts/ss1/tmp");
fs.mkdirSync(root, { recursive: true });
process.env.TMPDIR = root;
const timings: unknown[] = [];
const tasks = channel("openclaw.worker.task");
const observe = (event: unknown) => timings.push(event);
const measure = async <T>(run: () => T | Promise<T>) => {
  const start = performance.now();
  const value = await run();
  return { ms: performance.now() - start, value };
};
await withOpenClawTestState(
  { scenario: "minimal", label: "sessions-search-bench" },
  async (state) => {
    const database = { agentId: "main", path: state.statePath("search.sqlite"), env: state.env };
    const scope = { agentId: "main", storePath: database.path, env: state.env };
    const text = `${"synthetic transcript background context ".repeat(Math.ceil(words / 4))} needle`;
    runOpenClawAgentWriteTransaction((connection) => {
      for (let session = 0; session < sessions; session++) {
        const id = `session-${session}`;
        replaceSqliteTranscriptEventsInTransaction(
          connection,
          { ...scope, sessionId: id, sessionKey: `agent:main:${id}` },
          [
            { type: "session", id, version: 3 },
            ...Array.from({ length: messages }, (_, index) => ({
              type: "message" as const,
              id: `message-${index}`,
              parentId: index ? `message-${index - 1}` : null,
              timestamp: session * messages + index + 1,
              message: { role: "assistant", content: text },
            })),
          ],
          { scheduleProjectionReconcile: false },
        );
      }
    }, database);
    await waitForSessionTranscriptIndexReconcile(database);
    const request = { ...scope, query: "needle", limit: 25 };
    console.log(
      JSON.stringify({
        sessions,
        messages,
        words,
        samples,
        node: process.version,
        cores: os.availableParallelism(),
        load: os.loadavg(),
        databaseBytes: fs.statSync(database.path).size,
        workers: transcriptSearchLane.pool.getSnapshot().maxWorkers,
      }),
    );
    // Native decomposition uses the same production filtered kernel, with a synthetic allow-all viewer.
    // Replay its captured statement without snippet(), then MATCH alone: deltas attribute query work,
    // not mutually exclusive SQLite engine phases. Keep this diagnostic pass separate from timing.
    let candidateSql = "";
    let candidateBindings: SQLInputValue[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(StatementSync.prototype, "iterate")!;
    const iterate = descriptor.value;
    assert(iterate);
    StatementSync.prototype.iterate = new Proxy(iterate, {
      apply(target, receiver: StatementSync, args) {
        if (receiver.sourceSQL.includes('as "snippet"')) {
          candidateSql = receiver.sourceSQL;
          candidateBindings = args;
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    let filterMs = 0;
    let candidates = 0;
    const native = await measure(() =>
      searchSessionTranscriptsFiltered(
        request,
        database,
        {
          consumeInput() {},
          notify() {},
          async request(keys: unknown) {
            assert(Array.isArray(keys));
            const start = performance.now();
            const input = keys.map(() => true);
            candidates += input.length;
            filterMs += performance.now() - start;
            return { input, consumed() {} };
          },
        },
        () => {},
      ),
    );
    Object.defineProperty(StatementSync.prototype, "iterate", descriptor);
    const db = openOpenClawAgentDatabase(database).db;
    const match = await measure(() =>
      db
        .prepare(
          "SELECT count(*) AS n FROM session_transcript_fts WHERE session_transcript_fts MATCH ?",
        )
        .get('"needle"'),
    );
    let withoutSnippetsMs: number | undefined;
    if (candidateSql.includes("snippet(")) {
      const sql = candidateSql.replace(/snippet\([^)]*\) as "snippet"/u, "'' as \"snippet\"");
      withoutSnippetsMs = (
        await measure(() => {
          const cursor = db.prepare(sql).iterate(...candidateBindings);
          for (let i = 0; i < candidates + 1; i++) {
            if (cursor.next().done) {
              break;
            }
          }
          cursor.return?.();
        })
      ).ms;
    }
    const capture = await measure(() => captureOpenClawAgentDatabaseExecutionAsync(database));
    try {
      const status = await measure(() => readSessionTranscriptIndexStatus(database));

      const shaping = await measure(() => JSON.stringify(native.value));
      console.log(
        JSON.stringify({
          phase: "decomposition",
          nativeMs: native.ms,
          matchMs: match.ms,
          withoutSnippetsMs,
          filterMs,
          candidates,
          captureMs: capture.ms,
          readinessMs: status.ms,
          shapingMs: shaping.ms,
        }),
      );
      const append = () =>
        appendTranscriptMessage(
          { ...scope, sessionId: "session-0", sessionKey: "agent:main:session-0" },
          { message: { role: "user", content: "Unrelated synthetic append" } },
        );
      console.log(JSON.stringify({ phase: "writer-control", ms: (await measure(append)).ms }));
      // A held visibility exchange sits inside the actual search; a writer must settle before release.
      let releaseFilter!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseFilter = resolve;
      });
      let enteredFilter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredFilter = resolve;
      });
      const heldSearch = searchSessionTranscripts(request, database, async (keys) => {
        enteredFilter();
        await hold;
        return keys.map(() => true);
      });
      await entered;
      const write = await measure(append);
      releaseFilter();
      await heldSearch;
      console.log(
        JSON.stringify({
          phase: "writer-during-search",
          ms: write.ms,
          persisted: Boolean(write.value),
        }),
      );
      await Promise.all(
        Array.from({ length: 6 }, () =>
          searchSessionTranscripts(request, database, async (keys) => keys.map(() => true)),
        ),
      );
      console.log(
        JSON.stringify({
          phase: "warm-readiness",
          ...(await measure(() => readSessionTranscriptIndexStatus(database))),
        }),
      );
      tasks.subscribe(observe);
      try {
        for (let sample = 0; sample < samples; sample++) {
          const solo = await measure(() =>
            searchSessionTranscripts(request, database, async (keys) => keys.map(() => true)),
          );
          const start = performance.now();
          const completions = await Promise.all(
            Array.from({ length: 6 }, async () => {
              const result = await searchSessionTranscripts(request, database, async (keys) =>
                keys.map(() => true),
              );
              assert.deepEqual(result, solo.value);
              return performance.now() - start;
            }),
          );
          console.log(
            JSON.stringify({
              sample,
              load: os.loadavg(),
              resultHash: createHash("sha256").update(JSON.stringify(solo.value)).digest("hex"),
              soloMs: solo.ms,
              completionsMs: completions,
              tasks: timings.splice(0),
              maxRssKiB: process.resourceUsage().maxRSS,
            }),
          );
        }
      } finally {
        tasks.unsubscribe(observe);
      }
    } finally {
      await capture.value.release();
    }
  },
);
