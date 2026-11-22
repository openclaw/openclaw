// Synthetic RPC history pages through the admitted worker and canonical writer.
// Build once with --build --fixture <dir>; reuse it for baseline/candidate samples.
// --owner-file selects the exact baseline input-visibility owner.
// --mode reads clears the SQLite page cache; timing/allocation retain warm pages.
// Compile scripts/perf/transcript-active-facts-vfs.c and pass --vfs-probe <library>.
// Logical VFS page spans include repeats; OS cache and physical I/O are not controlled.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, type MessagePort } from "node:worker_threads";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { ChatHistoryPageCursor } from "../../src/config/sessions/session-history-types.js";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

// Exercise dispatch's worker reader with the same host-owned SQLite write receipts.
if (isMainThread) {
  const { runPerfSqliteWorker } = await import("../lib/perf-sqlite-worker.ts");
  await runPerfSqliteWorker(new URL(import.meta.url), process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    build: { type: "boolean" },
    "owner-file": { type: "string" },
    "vfs-probe": { type: "string" },
    mode: { type: "string", default: "reads" },
    background: { type: "string", default: "4096" },
    sizes: { type: "string", default: "3600,36000" },
    iterations: { type: "string", default: "5" },
  },
});
assert(values.fixture && values.output && values["vfs-probe"]);
assert(["reads", "timing", "allocation"].includes(values.mode));
const fixture = path.resolve(values.fixture);
const output = path.resolve(values.output);
mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: path.join(fixture, "state"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
Object.assign(process.env, env);
const owner = new URL(
  "../../src/config/sessions/session-accessor.sqlite-history-input-visibility.ts",
  import.meta.url,
);
const replaced = registerPerfOwnerReplacement(owner.href, values["owner-file"]);
const { importSqliteSessionRowsBatch } =
  await import("../../src/config/sessions/session-accessor.sqlite-import.js");
const {
  resolveOpenClawAgentSqlitePath,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} = await import("../../src/state/openclaw-agent-db.js");
const { withHistoryDatabase } =
  await import("../../src/config/sessions/session-transcript-worker-scopes.js");
const { readSessionHistoryRequest } =
  await import("../../src/gateway/session-history-worker-reader.js");
const { OpenClawAgentDatabaseReadOnlyScope, withScopedOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly-scope.js");
const { requireNativeSqliteDatabase } = await import("../../src/test-utils/native-sqlite.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
assert(!values["owner-file"] || replaced());
const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
const sizes = values.sizes.split(",").map(Number);
const scopes = sizes.map((turns) => ({
  agentId: "main",
  sessionId: `history-${turns}`,
  sessionKey: `agent:main:history-${turns}`,
  storePath,
  env,
}));
const timestamp = "2026-11-01T00:00:00.000Z";
function* history(sessionId: string, turns: number, background = false) {
  yield { type: "session", version: 3, id: sessionId, timestamp };
  let parentId: string | null = null;
  for (let n = 0; n < turns; n++) {
    const messages = background
      ? [
          {
            role: "toolResult",
            toolCallId: `call-${n}`,
            toolName: "read",
            content: [{ type: "text", text: "b".repeat(2 * 1024 * 1024) + "\0" }],
          },
        ]
      : [
          { role: "user", content: "Question " + n, idempotencyKey: `run-${n}:user` },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: `call-${n}`, name: "read", arguments: {} }],
            provider: "example",
            model: "synthetic",
            api: "openai-responses",
            stopReason: "toolUse",
            __openclaw: { runId: `run-${n}` },
          },
          {
            role: "toolResult",
            toolCallId: `call-${n}`,
            toolName: "read",
            content: [{ type: "text", text: "x".repeat(32768) + "\0" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Answer " + n + " " + "a".repeat(3000) }],
            provider: "example",
            model: "synthetic",
            api: "openai-responses",
            stopReason: "stop",
            __openclaw: { runId: `run-${n}` },
          },
        ];
    for (const [j, message] of messages.entries()) {
      const id = `entry-${n}-${j}`;
      yield { type: "message", id, parentId, message, timestamp };
      parentId = id;
    }
  }
  if (!background) {
    yield {
      type: "compaction",
      timestamp,
      id: "compaction",
      parentId,
      firstKeptEntryId: `entry-${turns - 20}-0`,
      summary: "Synthetic compaction",
      tokensBefore: 100000,
    };
  }
}
if (values.build) {
  const entries = [
    ...scopes.map((scope, i) => ({ scope, turns: sizes[i]!, background: false })),
    ...Array.from({ length: Number(values.background) }, (_, i) => ({
      scope: {
        ...scopes[0]!,
        sessionId: `background-${i}`,
        sessionKey: `agent:main:background-${i}`,
      },
      turns: 4,
      background: true,
    })),
  ];
  for (let offset = 0; offset < entries.length; offset += 32) {
    await importSqliteSessionRowsBatch(
      entries.slice(offset, offset + 32).map(({ scope, turns, background }) =>
        Object.assign({}, scope, {
          entry: { sessionId: scope.sessionId, updatedAt: 1 },
          transcriptMtimeMs: 1,
          readTranscriptEvents(append: (event: TranscriptEvent) => void) {
            for (const event of history(scope.sessionId, turns, background)) {
              append(event);
            }
          },
        }),
      ),
    );
    if (offset % 256 === 0) {
      console.log(
        JSON.stringify({ built: Math.min(offset + 32, entries.length), total: entries.length }),
      );
    }
  }
  openOpenClawAgentDatabase({ agentId: "main", env }).db.exec("ANALYZE");
  await closeOpenClawAgentDatabasesAsync();
}
const admitted = new Promise<MessagePort>((resolve) => {
  parentPort!.once("message", resolve);
});
parentPort!.postMessage(storePath, []);
const port = await admitted;
const { withSqliteDatabaseAdmissionExchange } =
  await import("../../src/infra/sqlite-database-admission-context.js");
const { exchangeSqliteDatabaseAdmissions } =
  await import("../../src/infra/sqlite-worker-database-admission-relay.js");
const probe = new DatabaseSync(":memory:", { allowExtension: true });
probe.loadExtension(path.resolve(values["vfs-probe"]), "sqlite3_bufprobe_init");
probe.prepare("SELECT buf696_target(?,1)").get(storePath);
const inspector = new Session();
const samples: unknown[] = [];
const metadata = {
  node: process.version,
  platform: os.platform(),
  load: os.loadavg(),
  dbBytes: statSync(storePath).size,
  ownerSha256: hash("sha256", readFileSync(values["owner-file"] ?? owner)),
  mode: values.mode,
};
console.log(JSON.stringify(metadata));
try {
  await withSqliteDatabaseAdmissionExchange(
    (records, location, create, observed) =>
      exchangeSqliteDatabaseAdmissions(port, records, location, create, observed),
    async () => {
      for (const scope of scopes) {
        const target = { agentId: "main", path: storePath };
        await withHistoryDatabase(target, "history.rpc", async () => {
          const opened = withScopedOpenClawAgentDatabaseReadOnly((database) => database.db, target);
          assert(opened.found);
          const db = opened.value;
          const native = requireNativeSqliteDatabase(db);
          const readRequest = async (offset?: number, pageCursor?: ChatHistoryPageCursor) => {
            const result = await readSessionHistoryRequest(
              {
                kind: "rpc",
                params: {
                  entry: { sessionId: scope.sessionId, updatedAt: 1 },
                  provider: undefined,
                  sessionId: scope.sessionId,
                  storePath,
                  sessionAgentId: "main",
                  canonicalKey: scope.sessionKey,
                  max: 200,
                  maxHistoryBytes: 512 * 1024,
                  responseHistoryBytes: 280000,
                  effectiveMaxChars: 8000,
                  encodeResponse: true,
                  offset,
                  messageId: pageCursor?.messageId,
                  pageCursor,
                },
              },
              {
                transcript: { ...scope, sessionFile: scope.sessionKey },
                database: target,
                stateDatabase: {
                  path: path.join(fixture, "state", "openclaw.sqlite"),
                  environment: env,
                },
              },
            );
            assert(result.kind === "rpc");
            return result.page;
          };
          const read = async (offset?: number, pageCursor?: ChatHistoryPageCursor) => {
            if (values.mode !== "reads") {
              return readRequest(offset, pageCursor);
            }
            const fresh = new OpenClawAgentDatabaseReadOnlyScope();
            try {
              return await fresh.run(target, () => {
                withScopedOpenClawAgentDatabaseReadOnly(({ db: freshDb }) => {
                  freshDb.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048");
                }, target);
                return readRequest(offset, pageCursor);
              });
            } finally {
              fresh.close();
            }
          };
          const head = await read();
          const { decodeChatHistoryPageCursor } =
            await import("../../src/gateway/chat-history-page-cursor.js");
          const older = decodeChatHistoryPageCursor(head.encodedResponse?.olderCursor);
          assert(older);
          const selections: { label: string; offset?: number; cursor?: ChatHistoryPageCursor }[] = [
            { label: "tail" },
            { label: "offset", offset: 200 },
            { label: "older", cursor: older },
          ];
          for (const { label, offset, cursor } of selections) {
            const golden = await read(offset, cursor);
            const bytes = JSON.stringify(golden);
            writeFileSync(path.join(output, `${scope.sessionId}-${label}.json`), bytes);
            for (let i = 0; i < Number(values.iterations); i++) {
              probe.prepare("SELECT buf696_reset()").get();
              if (values.mode === "allocation") {
                inspector.connect();
                await inspector.post("HeapProfiler.startSampling", {
                  samplingInterval: 8192,
                  includeObjectsCollectedByMajorGC: true,
                  includeObjectsCollectedByMinorGC: true,
                });
              }
              const cpu = process.threadCpuUsage();
              const started = performance.now();
              const page = await read(offset, cursor);
              const wallMs = performance.now() - started;
              const total = process.threadCpuUsage();
              const profile =
                values.mode === "allocation"
                  ? await inspector.post("HeapProfiler.stopSampling")
                  : undefined;
              if (profile) {
                inspector.disconnect();
              }
              const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
                node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
              const io = JSON.parse(String(probe.prepare("SELECT buf696_io() AS io").get()!.io));
              assert.equal(hash("sha256", JSON.stringify(page)), hash("sha256", bytes));
              const sample = {
                session: scope.sessionId,
                shape: label,
                iteration: i,
                wallMs,
                cpuMs: (total.user - cpu.user + total.system - cpu.system) / 1000,
                allocatedBytes: profile ? sum(profile.profile.head) : undefined,
                io,
                replyBytes: page.encodedResponse!.messages.byteLength,
                sha256: hash("sha256", bytes),
              };
              samples.push(sample);
              console.log(JSON.stringify(sample));
            }
          }
          if (values.mode === "reads") {
            const queries: string[] = [];
            const proto = Object.getPrototypeOf(native.prepare("SELECT 1"));
            const original = proto.iterate;
            proto.iterate = function (...args: unknown[]) {
              const result = Reflect.apply(original, this, args);
              queries.push(this.expandedSQL);
              return result;
            };
            try {
              await read();
            } finally {
              proto.iterate = original;
            }
            writeFileSync(
              path.join(output, `${scope.sessionId}-plans.json`),
              JSON.stringify(
                [...new Set(queries)].map((sql) => ({
                  sql,
                  plan: native.prepare("EXPLAIN QUERY PLAN " + sql).all(),
                })),
                null,
                2,
              ),
            );
          }
        });
      }
    },
  );
  writeFileSync(path.join(output, "result.json"), JSON.stringify({ metadata, samples }, null, 2));
} finally {
  probe.prepare("SELECT buf696_restore()").get();
  probe.close();
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  port.close();
  parentPort!.close();
}
process.exit(0);
