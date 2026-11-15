/**
 * Reproduce cold shared-state readiness after a real clean close, without production data.
 * nice -n 19 node --import ./scripts/tsx.mjs scripts/perf/startup-state-readiness-measure.ts
 *   --state-dir /absolute/fresh-directory --baseline-source /absolute/prior-state-schema-preflight.ts
 * Defaults: 1 and 14 GiB state fixtures, five counterbalanced pairs and A/A controls.
 * The 14 GiB fixture also has a 35 GiB agent and 3,000 sessions (--agent-gib changes size).
 * Every sample is a fresh process; filesystem caches are not reset. SQL timing and sampled V8
 * allocation come from the actual inspection child. Native allocations are not measured.
 * This measures database-readiness, not whole Gateway/model readiness or cold btrfs I/O.
 * Acceptance: valid seals cause zero full/FK scans; lower median owner wall/CPU, with no
 * material allocation regression. A/A controls expose host noise. Unsealed safety is tested
 * separately by the owning regression suite. Existing directories are never overwritten.
 * --prior-schema-source seeds and seals with an earlier canonical state SQL definition.
 * Both arms must then scan once; after a real current-runtime open/close, A/A controls
 * must reuse the new seal. --baseline-checks 0 compares diagnostic-only changes on hits.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "baseline-source": { type: "string" },
    "prior-schema-source": { type: "string" },
    "baseline-checks": { type: "string" },
    sizes: { type: "string", default: "1,14" },
    samples: { type: "string", default: "5" },
    "agent-gib": { type: "string", default: "35" },
    mode: { type: "string", default: "run" },
    arm: { type: "string", default: "candidate" },
    gib: { type: "string", default: "1" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const entry = fileURLToPath(import.meta.url);
const owner = fileURLToPath(
  new URL("../../src/state/openclaw-state-schema-preflight.ts", import.meta.url),
);
const loader = fileURLToPath(new URL("../tsx.mjs", import.meta.url));
const count = (raw: string | undefined, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const record = (row: unknown) => console.log(`MEASURE ${JSON.stringify(row)}`);

if (values.mode === "run") {
  assert(values["baseline-source"], "--baseline-source is required");
  assert(!existsSync(root), "Use a fresh directory; existing data is never replaced");
  mkdirSync(root, { recursive: true });
  const baseline = path.resolve(values["baseline-source"]);
  const priorSchema = values["prior-schema-source"]
    ? readFileSync(path.resolve(values["prior-schema-source"]), "utf8")
    : undefined;
  const baselineChecks = parseStrictIntegerOption({
    raw: values["baseline-checks"],
    label: "baseline-checks",
    min: 0,
    fallback: 1,
  });
  const preload = path.join(root, "observe.cjs");
  // Observe only the selected owner, so imports and unrelated worker allocations stay separate.
  writeFileSync(
    preload,
    `
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { registerHooks, stripTypeScriptTypes } = require('node:module');
const { Session } = require('node:inspector');
const { DatabaseSync, StatementSync } = require('node:sqlite');
const sql = new WeakMap();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(query) {
  const statement = prepare.call(this, query);
  sql.set(statement, query);
  return statement;
};
let active;
function category(statement) {
  const query = sql.get(statement) || '';
  const match = /^PRAGMA\\s+(integrity_check|quick_check|foreign_key_check|page_count|freelist_count)/i.exec(query);
  return match ? match[1].toLowerCase() : /config_machine_state NOT INDEXED/i.test(query) ? 'ownership_scan' : undefined;
}
for (const method of ['all', 'get']) {
  const native = StatementSync.prototype[method];
  StatementSync.prototype[method] = function(...args) {
    const key = active && category(this);
    if (!key) return native.apply(this, args);
    const start = performance.now();
    try { return native.apply(this, args); }
    finally { const row = active.sql[key] ||= { count: 0, ms: 0 }; row.count++; row.ms += performance.now()-start; }
  };
}
const iterate = StatementSync.prototype.iterate;
StatementSync.prototype.iterate = function(...args) {
  const key = active && category(this);
  if (!key) return iterate.apply(this, args);
  const receiver = this;
  return (function* () {
    const start = performance.now();
    try { yield* iterate.apply(receiver, args); }
    finally { const row = active.sql[key] ||= { count: 0, ms: 0 }; row.count++; row.ms += performance.now()-start; }
  })();
};
function post(session, command, params = {}) {
  let result, failure, complete = false;
  session.post(command, params, (error, value) => { failure = error; result = value; complete = true; });
  if (!complete) throw new Error('Inspector operation did not complete synchronously: ' + command);
  if (failure) throw failure;
  return result;
}
function allocated(node) { return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0); }
globalThis.__measureStateReadiness = function(operation) {
  const session = new Session(); session.connect();
  if (process.env.READINESS_ALLOCATION === '1') post(session, 'HeapProfiler.startSampling', {samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true});
  if (process.env.READINESS_PROFILE === '1') { post(session, 'Profiler.enable'); post(session, 'Profiler.start'); }
  const row = { sql: {} };
  active = row;
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const start = performance.now();
  try { return operation(); }
  finally {
    row.wallMs = performance.now()-start;
    const used = process.cpuUsage(cpu); row.cpuMs = (used.user + used.system)/1000;
    row.heapDeltaBytes = process.memoryUsage().heapUsed-memory.heapUsed;
    row.rssBytes = process.memoryUsage().rss;
    active = undefined;
    if (process.env.READINESS_ALLOCATION === '1') row.allocatedBytes = allocated(post(session, 'HeapProfiler.stopSampling').profile.head);
    if (process.env.READINESS_PROFILE === '1') fs.writeFileSync(process.env.READINESS_METRICS + '.cpuprofile', JSON.stringify(post(session, 'Profiler.stop').profile));
    session.disconnect();
    fs.appendFileSync(process.env.READINESS_METRICS, JSON.stringify(row) + '\\n');
  }
};
registerHooks({ load(url, context, nextLoad) {
  if (process.env.READINESS_SEED_SCHEMA === '1' && url === ${JSON.stringify(new URL("../../src/state/openclaw-state-schema.ts", import.meta.url).href)}) {
    return { format: 'module', shortCircuit: true, source: 'export const OPENCLAW_STATE_SCHEMA_SQL = ' + ${JSON.stringify(JSON.stringify(priorSchema))} + ';' };
  }
  if (!url.startsWith('file:') || fileURLToPath(url) !== ${JSON.stringify(owner)}) return nextLoad(url, context);
  let source = fs.readFileSync(process.env.READINESS_ARM === 'baseline' ? ${JSON.stringify(baseline)} : ${JSON.stringify(owner)}, 'utf8');
  const signature = 'export function inspectStateDatabaseSchema(';
  if (source.split(signature).length !== 2) throw new Error('Owner instrumentation no longer matches');
  source = source.replace(signature, 'function inspectStateDatabaseSchemaKernel(');
  source += '\\nexport function inspectStateDatabaseSchema(database, input) { return globalThis.__measureStateReadiness(() => inspectStateDatabaseSchemaKernel(database, input)); }\\n';
  return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(source) };
}});
`,
  );
  const outputs: unknown[] = [];
  const child = (
    directory: string,
    mode: string,
    gib: string,
    arm = "candidate",
    allocation = false,
    profile = false,
  ) => {
    const metrics = path.join(root, `owner-${outputs.length}.jsonl`);
    const result = spawnSync(
      "/usr/bin/time",
      [
        "-p",
        process.execPath,
        "--import",
        loader,
        entry,
        "--state-dir",
        directory,
        "--mode",
        mode,
        "--gib",
        gib,
        "--arm",
        arm,
        "--agent-gib",
        values["agent-gib"],
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          ...(mode === "sample" || (mode === "seed" && priorSchema)
            ? {
                NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`]
                  .filter(Boolean)
                  .join(" "),
              }
            : {}),
          READINESS_ARM: arm,
          READINESS_SEED_SCHEMA: mode === "seed" && priorSchema ? "1" : "0",
          READINESS_METRICS: metrics,
          READINESS_ALLOCATION: allocation ? "1" : "0",
          READINESS_PROFILE: profile ? "1" : "0",
        },
      },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.status, 0, `${mode}/${arm} failed`);
    const line = result.stdout.split("\n").findLast((row) => row.startsWith("MEASURE "));
    assert(line);
    const row = JSON.parse(line.slice(8));
    const timing = /real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s+([\d.]+)/u.exec(result.stderr);
    assert(timing);
    Object.assign(row, {
      arm,
      allocation,
      profile,
      gib: Number(gib),
      processWallMs: Number(timing[1]) * 1000,
      processCpuMs: (Number(timing[2]) + Number(timing[3])) * 1000,
      ...(existsSync(metrics)
        ? {
            owners: readFileSync(metrics, "utf8")
              .trim()
              .split("\n")
              .map((item) => JSON.parse(item)),
          }
        : {}),
    });
    if (mode === "sample") {
      assert.equal(row.owners.length, 1, "Expected one shared-state inspection");
      const checks =
        arm === "reopened" ? 0 : priorSchema ? 1 : arm === "baseline" ? baselineChecks : 0;
      assert.equal(row.owners[0].sql.integrity_check?.count ?? 0, checks);
      assert.equal(row.owners[0].sql.foreign_key_check?.count ?? 0, checks);
      if (priorSchema && arm !== "baseline") {
        assert.equal(row.counters.stateIntegrityReason, checks ? "schema-mismatch" : undefined);
      }
    }
    outputs.push(row);
    writeFileSync(path.join(root, "measurements.json"), JSON.stringify(outputs, null, 2) + "\n");
    record(row);
  };
  writeFileSync(
    path.join(root, "acceptance.txt"),
    "Fresh processes; filesystem cache is not reset. Report first touch and cache pressure separately. Sizes " +
      values.sizes +
      " GiB. Five counterbalanced pairs by default, plus two candidate A/A controls. " +
      (priorSchema || baselineChecks === 0
        ? "Diagnostic-only comparison: preserve integrity/FK scan counts with no material owner timing/CPU/allocation regression. Prior-schema seals require one scan; a current-runtime clean close restores zero-scan admission. "
        : "Candidate must remove full integrity/FK scans with valid production seal; lower median owner wall and CPU, no material sampled V8 allocation regression. ") +
      "Report p95/spread, process CPU and host load. No whole Gateway/btrfs claim.\n",
  );
  for (const gib of values.sizes.split(",")) {
    count(gib, "sizes");
    const directory = path.join(root, `${gib}gib`);
    mkdirSync(directory);
    child(directory, "seed", gib);
    for (const allocation of [false, true]) {
      for (let i = 0; i < 2; i++) {
        child(directory, "sample", gib, "control", allocation);
      }
    }
    for (const allocation of [false, true]) {
      for (let sample = 0; sample < count(values.samples, "samples"); sample++) {
        for (const arm of sample % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
          child(directory, "sample", gib, arm, allocation);
        }
      }
    }
    for (const arm of ["baseline", "candidate"]) {
      child(directory, "sample", gib, arm, false, true);
    }
    if (priorSchema) {
      child(directory, "reseal", gib);
      for (const allocation of [false, true]) {
        for (let i = 0; i < 2; i++) {
          child(directory, "sample", gib, "reopened", allocation);
        }
      }
    }
  }
} else {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  Object.assign(process.env, env);
  const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.js");
  if (values.mode === "seed") {
    writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}\n");
    const state = openOpenClawStateDatabase({ env });
    const payload = Buffer.alloc(1024 * 1024, 120);
    const rows = count(values.gib, "gib") * 1024;
    const insert = state.db.prepare(
      "INSERT INTO plugin_blob_entries(plugin_id,namespace,entry_key,metadata_json,blob,created_at) VALUES('synthetic','readiness',?,'{}',?,1)",
    );
    const started = performance.now();
    for (let offset = 0; offset < rows; offset += 64) {
      state.db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = offset; i < Math.min(rows, offset + 64); i++) {
          insert.run(`synthetic-payload-${i}`, payload);
        }
        state.db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
    }
    let agentBytes = 0;
    if (Number(values.gib) >= 14) {
      const {
        openOpenClawAgentDatabase,
        runOpenClawAgentWriteTransaction,
        closeOpenClawAgentDatabasesAsync,
      } = await import("../../src/state/openclaw-agent-db.js");
      const agentOptions = { agentId: "synthetic", env };
      const agent = openOpenClawAgentDatabase(agentOptions);
      runOpenClawAgentWriteTransaction(() => {
        const node = agent.db.prepare(
          "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES(?,?,?,1,1)",
        );
        const window = agent.db.prepare(
          "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
        );
        for (let i = 0; i < 3000; i++) {
          const id = `synthetic-${i}`;
          const key = `agent:synthetic:session-${i}`;
          node.run(key, id, JSON.stringify({ sessionId: id, updatedAt: 1 }));
          window.run(id, key);
        }
      }, agentOptions);
      const event = agent.db.prepare(
        "INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,message_role) VALUES(?,?,?,1,'message','toolResult')",
      );
      const eventPayload = JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: payload.toString() }] },
      });
      const eventRows = count(values["agent-gib"], "agent-gib") * 1024;
      for (let offset = 0; offset < eventRows; offset += 64) {
        runOpenClawAgentWriteTransaction(() => {
          for (let i = offset; i < Math.min(offset + 64, eventRows); i++) {
            event.run(`synthetic-${i % 3000}`, Math.floor(i / 3000) + 1, eventPayload);
          }
        }, agentOptions);
        agent.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      await closeOpenClawAgentDatabasesAsync();
      agentBytes = statSync(agent.path).size;
      writeFileSync(
        env.OPENCLAW_CONFIG_PATH,
        JSON.stringify({
          agents: {
            entries: { synthetic: {} },
            defaults: { systemAgent: { agentId: "synthetic" } },
          },
        }),
      );
    }
    await closeOpenClawStateDatabaseAsync();
    const { readSqliteDatabaseCleanClose } =
      await import("../../src/infra/sqlite-database-admission.js");
    assert(
      readSqliteDatabaseCleanClose(state.path),
      "Seed must have genuine production clean-close proof",
    );
    record({
      phase: "seed",
      bytes: statSync(state.path).size,
      agentBytes,
      agentSessions: agentBytes ? 3000 : 0,
      rows,
      seedMs: performance.now() - started,
      node: process.version,
    });
  } else if (values.mode === "reseal") {
    const state = openOpenClawStateDatabase({ env });
    await closeOpenClawStateDatabaseAsync();
    assert(existsSync(`${state.path}.seal`), "Current runtime must publish a clean-close seal");
    record({ phase: "reseal" });
  } else {
    const { assertOpenClawDatabasesReady } =
      await import("../../src/state/openclaw-database-preflight.js");
    const { withLiveStateReads } =
      await import("../../src/state/artifact-preserving-state-reads.js");
    let counters;
    const load = loadavg();
    const cpu = process.cpuUsage();
    const started = performance.now();
    await withLiveStateReads(() =>
      assertOpenClawDatabasesReady({
        env,
        config: JSON.parse(readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")),
        operation: "gateway-startup",
        onAgentInspection(stats) {
          counters = stats;
        },
      }),
    );
    const wallMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    record({
      phase: "sample",
      wallMs,
      parentCpuMs: (used.user + used.system) / 1000,
      counters,
      load,
    });
    await closeOpenClawStateDatabaseAsync();
  }
}
