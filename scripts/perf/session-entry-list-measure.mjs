/**
 * Synthetic selected-list SQL owner benchmark, including its read transaction.
 * Seed with session-read-transactions-fixture.mjs. Run timing/allocation separately:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-entry-list-measure.mjs \
 *   --root .local/lane2035/fixture --output result.json [--baseline frozen-owner.ts]
 * Freeze the original entry-list owner with relative imports resolved to source paths.
 * Without --baseline both arms use identical code (A/A). Five counterbalanced pairs;
 * imports, warmup and explicit GC excluded. CPU/allocation cover the SQL isolate,
 * not Gateway transport or native SQLite allocation. --mode sql records actual queries
 * and plans separately; returned rows count native-to-JS delivery, not VM scan visits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    baseline: { type: "string" },
    control: { type: "boolean" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5" },
    "session-key": { type: "string" },
    projection: { type: "string", default: "full" },
  },
});
assert(values.root && values.output && global.gc);
assert(["timing", "allocation", "sql", "profile"].includes(values.mode));
assert(["full", "list"].includes(values.projection));
assert(!fs.existsSync(values.output), "Refusing to overwrite evidence");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8")).format,
  "openclaw-session-read-transactions-v1",
);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
});
const agent = await import("../../src/state/openclaw-agent-db.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const { resolveSqliteScope } =
  await import("../../src/config/sessions/session-accessor.sqlite-read-scope.ts");
const candidate =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-list.read.ts");
const { readWithCanonicalSessionReaderContinuation } =
  await import("../../src/config/sessions/session-canonical-key.ts");
const baseline = values.baseline
  ? await import(pathToFileURL(path.resolve(values.baseline)).href)
  : candidate;
const database = agent.openOpenClawAgentDatabase({ agentId: "main" });
const sessionKey =
  values["session-key"] ??
  database.db.prepare("SELECT session_key FROM session_nodes ORDER BY session_key LIMIT 1").get()
    .session_key;
const scope = {
  agentId: "main",
  storePath: database.path,
  sessionKey: "",
  sessionKeys: [sessionKey],
  projection: values.projection,
  includeParticipants: false,
  readConsistency: "latest",
};
const resolved = resolveSqliteScope(scope);
const operations = [baseline, values.control ? baseline : candidate].map(
  (owner) => () =>
    readWithCanonicalSessionReaderContinuation(database, undefined, () =>
      owner.listSqliteSessionEntriesFromDatabase(database, resolved, scope),
    ),
);
let digest;
function check(result) {
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionKey, sessionKey);
  const next = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  digest ??= next;
  assert.equal(next, digest);
}
const evidence = {
  mode: values.mode,
  projection: values.projection,
  node: process.version,
  load: loadavg(),
  iterations,
  samples: [],
  sql: [],
};
const inspector = new Session();
try {
  for (const run of operations) {
    check(run());
  }
  if (values.mode === "sql") {
    const original = new Map();
    let rows;
    for (const method of ["all", "get", "iterate"]) {
      original.set(method, StatementSync.prototype[method]);
      StatementSync.prototype[method] = function (...args) {
        const result = Reflect.apply(original.get(method), this, args);
        const record = { query: this.expandedSQL, rows: 0 };
        rows.push(record);
        if (method === "iterate") {
          return (function* () {
            for (const row of result) {
              record.rows++;
              yield row;
            }
          })();
        }
        record.rows = Array.isArray(result) ? result.length : Number(result !== undefined);
        return result;
      };
    }
    try {
      for (const [arm, run] of operations.entries()) {
        rows = [];
        check(run());
        evidence.sql.push({ arm, queries: rows });
      }
    } finally {
      for (const [method, implementation] of original) {
        StatementSync.prototype[method] = implementation;
      }
    }
    for (const arm of evidence.sql) {
      for (const row of arm.queries) {
        if (/^select\b/i.test(row.query)) {
          row.plan = database.db.prepare(`EXPLAIN QUERY PLAN ${row.query}`).all();
        }
      }
    }
  } else {
    inspector.connect();
    if (values.mode === "profile") {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    for (let pair = 0; pair < 5; pair++) {
      for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
        global.gc();
        if (values.mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        let result;
        for (let iteration = 0; iteration < iterations; iteration++) {
          result = operations[arm]();
        }
        const wallMs = (performance.now() - start) / iterations;
        const used = process.threadCpuUsage(cpu);
        const sample = { pair, arm, wallMs, cpuMs: (used.user + used.system) / 1000 / iterations };
        if (values.mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const sum = (node) =>
            node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
          sample.sampledBytes = sum(profile.head) / iterations;
        }
        check(result);
        evidence.samples.push(sample);
      }
    }
    if (values.mode === "profile") {
      const { profile } = await inspector.post("Profiler.stop");
      fs.writeFileSync(`${values.output}.cpuprofile`, JSON.stringify(profile));
    }
  }
  evidence.digest = digest;
  evidence.finalLoad = loadavg();
  fs.writeFileSync(values.output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence.mode === "sql" ? { output: values.output } : evidence));
} finally {
  inspector.disconnect();
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
