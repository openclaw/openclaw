/**
 * Measure transcript SQL owners on a synthetic schema-39 fixture.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-read-transactions-owners.mjs \
 *   --database .local/lane2035/fixture/agent.sqlite --session-id session-0 \
 *   --session-key agent:main:session-0 --operation bounded --mode timing --output result.json
 * A/A arms are counterbalanced controls unless --baseline supplies an earlier
 * cache-TTL prefix, navigation, or transcript-match owner; --control uses the baseline in both arms.
 * The controls workload isolates the legacy-control scan used by bounded hydration. Timing, sampled
 * V8 allocation, SQL plans/counts and CPU profiles run separately. This directly
 * invokes worker-owned SQL code; it does not measure Gateway transport or btrfs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSessionTranscriptBoundedActiveContextCore } from "../../src/config/sessions/session-accessor.sqlite-active-context.ts";
import { iterateUnindexedTranscriptNavigation } from "../../src/config/sessions/session-accessor.sqlite-history-navigation.ts";
import { readCurrentProjectionSnapshot } from "../../src/config/sessions/session-accessor.sqlite-projection-read.ts";
import { readCacheTtlProjectionPrefix } from "../../src/config/sessions/session-cache-ttl-prefix.ts";
import { findTranscriptEventMatchingInDatabase } from "../../src/config/sessions/session-transcript-match-read.ts";
import { readTranscriptPayload } from "../../src/config/sessions/transcript-payload.ts";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync.ts";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.ts";
import { admitSqliteSchema } from "../../src/infra/sqlite-schema-facts.ts";
import { runSqliteReadSnapshotSync } from "../../src/infra/sqlite-transaction.ts";

const { values } = parseArgs({
  options: {
    database: { type: "string" },
    "session-id": { type: "string" },
    "session-key": { type: "string" },
    baseline: { type: "string" },
    control: { type: "boolean", default: false },
    "anchor-position": { type: "string", default: "1000" },
    "run-id": { type: "string", default: "synthetic-absent-run" },
    key: { type: "string", default: "synthetic-absent-key" },
    operation: { type: "string", default: "bounded" },
    mode: { type: "string", default: "timing" },
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "1" },
    output: { type: "string" },
  },
});
assert(values.database && values["session-id"] && values["session-key"] && values.output);
assert(
  ["bounded", "controls", "prefix", "latest", "visible-final", "idempotency"].includes(
    values.operation,
  ),
);
assert(["timing", "allocation", "plans", "profile"].includes(values.mode));
assert(global.gc, "Use --expose-gc");
assert(!fs.existsSync(values.output), "Refusing to overwrite measurement evidence");
assert(!values.control || values.baseline, "--control requires --baseline");
const samples = Number(values.samples),
  iterations = Number(values.iterations);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const pathname = path.resolve(values.database);
const db = openNodeSqliteDatabase(pathname, { readOnly: true });
admitSqliteSchema(db);
const database = { agentId: "main", path: pathname, db };
const target = {
  agentId: "main",
  sessionId: values["session-id"],
  sessionKey: values["session-key"],
  storePath: pathname,
  path: pathname,
};
const anchorPosition = Number(values["anchor-position"]);
assert(Number.isSafeInteger(anchorPosition) && anchorPosition >= 0);
const anchorRow =
  values.operation === "prefix"
    ? db
        .prepare(`SELECT event.event_json,
  event.event_zstd, event.event_utf8_bytes FROM session_transcript_active_events AS active
  JOIN transcript_events AS event ON event.session_id=active.session_id AND event.seq=active.event_seq
  WHERE active.session_id=? AND active.active_position=?`)
        .get(target.sessionId, anchorPosition)
    : undefined;
const anchorEntry = anchorRow ? JSON.parse(readTranscriptPayload(anchorRow)) : undefined;
if (values.operation === "prefix") {
  assert.equal(typeof anchorEntry?.id, "string", "Prefix anchor must exist in the fixture");
  assert.equal(anchorEntry.type, "message", "Prefix comparison uses an ordinary message anchor");
}
const makeRead =
  (prefixOwner, controlsOwner, matchOwner = findTranscriptEventMatchingInDatabase) =>
  () =>
    runSqliteReadSnapshotSync(db, () =>
      values.operation === "prefix"
        ? readCurrentProjectionSnapshot(database, target, (projection) =>
            prefixOwner(projection, {
              activePosition: anchorPosition,
              id: anchorEntry.id,
              entry: anchorEntry,
            }),
          )
        : values.operation === "controls"
          ? readCurrentProjectionSnapshot(database, target, (projection) =>
              Array.from(controlsOwner(projection, { controlsOnly: true })),
            )
          : values.operation === "bounded"
            ? readSessionTranscriptBoundedActiveContextCore(target, {
                maxEvents: 50,
                maxBytes: 1024000,
                transaction: database,
                resolvedScope: target,
              })
            : matchOwner(database, {
                target,
                match:
                  values.operation === "latest"
                    ? { kind: "latest" }
                    : values.operation === "idempotency"
                      ? { kind: "idempotency", key: values.key }
                      : { kind: "visible-final", runId: values["run-id"] },
              }),
    );
let read = makeRead(readCacheTtlProjectionPrefix, iterateUnindexedTranscriptNavigation);
let baselineRead;
if (values.baseline) {
  assert.notEqual(
    values.operation,
    "bounded",
    "Bounded-context baseline substitution is unsupported",
  );
  const ownerUrl = new URL(
    values.operation === "prefix"
      ? "../../src/config/sessions/session-cache-ttl-prefix.ts?comparison"
      : values.operation === "controls"
        ? "../../src/config/sessions/session-accessor.sqlite-history-navigation.ts?comparison"
        : "../../src/config/sessions/session-transcript-match-read.ts?comparison",
    import.meta.url,
  );
  const source = pathToFileURL(path.resolve(values.baseline));
  registerHooks({
    load(url, context, next) {
      if (url !== ownerUrl.href) {
        return next(url, context);
      }
      const loaded = next(source.href, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
  const baseline = await import(ownerUrl.href);
  baselineRead = makeRead(
    baseline.readCacheTtlProjectionPrefix,
    baseline.iterateUnindexedTranscriptNavigation,
    baseline.findTranscriptEventMatchingInDatabase,
  );
  if (values.control) {
    read = baselineRead;
    baselineRead = undefined;
  }
}
const digest = (result) =>
  createHash("sha256")
    .update(JSON.stringify(result) ?? "undefined")
    .digest("hex");
let expected;
if (values.mode !== "plans") {
  expected = digest(read());
}
const rows = [],
  statements = new Map();
const decoded = { calls: 0, bytes: 0 };
const inspector = new Session();
inspector.connect();
const sum = (node) => node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
const originalPrepare = db.prepare.bind(db);
let restore;
try {
  if (values.mode === "plans") {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.prepare = (text) => {
      const statement = originalPrepare(text);
      if (!/^select\b/i.test(text)) {
        return statement;
      }
      for (const method of ["get", "all", "iterate"]) {
        const execute = statement[method].bind(statement);
        statement[method] = (...bindings) => {
          let record = statements.get(text);
          if (!record) {
            record = {
              sql: text,
              bindings,
              calls: 0,
              rows: 0,
              textBytes: 0,
              executionMs: 0,
              plan: originalPrepare(`EXPLAIN QUERY PLAN ${text}`).all(...bindings),
            };
            statements.set(text, record);
          }
          record.calls++;
          const account = (row) => {
            if (row) {
              record.rows++;
              for (const value of Object.values(row)) {
                if (typeof value === "string") {
                  record.textBytes += Buffer.byteLength(value);
                }
              }
            }
            return row;
          };
          const started = performance.now();
          const result = execute(...bindings);
          record.executionMs += performance.now() - started;
          if (method === "get") {
            return account(result);
          }
          if (method === "all") {
            return result.map(account);
          }
          return (function* () {
            try {
              for (;;) {
                const stepStarted = performance.now();
                const next = result.next();
                record.executionMs += performance.now() - stepStarted;
                if (next.done) {
                  return;
                }
                yield account(next.value);
              }
            } finally {
              result.return?.();
            }
          })();
        };
      }
      return statement;
    };
    const parse = JSON.parse;
    JSON.parse = (...args) => {
      decoded.calls++;
      if (typeof args[0] === "string") {
        decoded.bytes += Buffer.byteLength(args[0]);
      }
      return parse(...args);
    };
    restore = () => {
      db.prepare = originalPrepare;
      JSON.parse = parse;
    };
    expected = digest(read());
  } else {
    for (let warmup = 0; warmup < 3; warmup++) {
      assert.equal(digest(read()), expected);
      if (baselineRead) {
        assert.equal(digest(baselineRead()), expected);
      }
    }
    if (values.mode === "profile") {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const arm of sample % 2 === 0 ? ["A1", "A2"] : ["A2", "A1"]) {
        global.gc();
        if (values.mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu = process.threadCpuUsage(),
          start = performance.now();
        let result;
        for (let iteration = 0; iteration < iterations; iteration++) {
          result = (arm === "A1" && baselineRead ? baselineRead : read)();
        }
        const wallMs = performance.now() - start,
          used = process.threadCpuUsage(cpu);
        const sampledV8Bytes =
          values.mode === "allocation"
            ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
        assert.equal(digest(result), expected);
        rows.push({
          sample,
          arm,
          iterations,
          wallMs,
          cpuMs: (used.user + used.system) / 1000,
          sampledV8Bytes,
          loadavg: loadavg(),
        });
      }
    }
    if (values.mode === "profile") {
      fs.writeFileSync(
        `${values.output}.cpuprofile`,
        JSON.stringify((await inspector.post("Profiler.stop")).profile),
      );
    }
  }
  fs.writeFileSync(
    values.output,
    JSON.stringify(
      {
        format: "session-read-transactions-owners-v1",
        operation: values.operation,
        mode: values.mode,
        databaseBytes: fs.statSync(pathname).size,
        sessionId: target.sessionId,
        runId: values.operation === "visible-final" ? values["run-id"] : undefined,
        key: values.operation === "idempotency" ? values.key : undefined,
        anchorPosition: values.operation === "prefix" ? anchorPosition : undefined,
        comparison: baselineRead ? "baseline/candidate" : "A/A",
        samples,
        iterations,
        expectedDigest: expected,
        rows,
        decoded,
        statements: [...statements.values()],
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output: values.output, operation: values.operation, mode: values.mode }),
  );
} finally {
  restore?.();
  inspector.disconnect();
  clearNodeSqliteKyselyCacheForDatabase(db);
  db.close();
}
