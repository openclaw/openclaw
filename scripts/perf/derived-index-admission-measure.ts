/**
 * Synthetic native agent-open benchmark. No Team data or Gateway/model readiness claim.
 * nice -n 19 node --expose-gc --import ./scripts/tsx.mjs scripts/perf/derived-index-admission-measure.ts --state-dir .local/index-admission --baseline-source /absolute/prior-agent-database-startup-integrity.ts
 * Default: 300k transcript events at 36 KiB, 10k sessions, 12,497 completions, 14 deliveries.
 * --rows 100 --payload-bytes 512 --samples 1 is a setup smoke. Use a fresh state directory.
 * A synthetic prior-catalog seal preserves a real seed close's proof and changes its schema
 * identity after removing the two indexes. This models the upgrade refusal, not an older binary.
 * Each open uses a fresh process; filesystem caches remain warm. Five counterbalanced pairs
 * follow two candidate A/A controls. Separate sampling passes count main-isolate JS allocation.
 * Acceptance: zero full checks in candidate, both indexes restored, lower median open/CPU,
 * and no material JS allocation regression. Owner CPU includes worker threads; external time also records complete process-tree CPU
 * including imports, validation, close and integrity children. Native allocations are excluded. No btrfs/fragmentation or cold-cache claim.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { OpenClawAgentDatabase } from "../../src/state/openclaw-agent-db-contract.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "baseline-source": { type: "string" },
    mode: { type: "string", default: "run" },
    arm: { type: "string", default: "candidate" },
    rows: { type: "string", default: "300000" },
    "payload-bytes": { type: "string", default: "36864" },
    samples: { type: "string", default: "5" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "--state-dir is required");
assert(global.gc, "Run with --expose-gc");
const root = path.resolve(values["state-dir"]);
const number = (key: "rows" | "payload-bytes" | "samples") =>
  parseStrictIntegerOption({ raw: values[key], label: key, min: 1, fallback: 1 });
const indexes = [
  "idx_agent_conversation_deliveries_source_session",
  "idx_agent_session_input_completions_session_key",
];
const options = {
  agentId: "main",
  path: path.join(root, "agent.sqlite"),
  env: {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  },
};
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: options.env.OPENCLAW_CONFIG_PATH,
});
const startupUrl = new URL("../../src/state/agent-database-startup-integrity.ts", import.meta.url)
  .href;
const observation: { diagnostics?: Record<string, unknown>; fullChecks: number } = {
  fullChecks: 0,
};
Object.assign(globalThis, { __indexAdmissionMeasure: observation });
const openerUrl = new URL("../../src/state/openclaw-agent-db.ts", import.meta.url).href;
const integrityUrl = new URL("../../src/infra/sqlite-integrity.ts", import.meta.url).href;
function replaceOnce(source: string, before: string, after: string): string {
  assert.equal(
    source.split(before).length,
    2,
    `Benchmark observation hook must match exactly once: ${before}`,
  );
  return source.replace(before, after);
}
registerHooks({
  load(url, context, nextLoad) {
    let source: string | undefined;
    if (url === startupUrl && values.arm === "baseline") {
      assert(values["baseline-source"], "Baseline needs --baseline-source");
      source = readFileSync(values["baseline-source"], "utf8");
    } else if (url === openerUrl) {
      source = replaceOnce(
        readFileSync(fileURLToPath(url), "utf8"),
        "const diagnostics: SqliteIntegrityDiagnostics = {};",
        "const diagnostics: SqliteIntegrityDiagnostics = {}; globalThis.__indexAdmissionMeasure.diagnostics = diagnostics;",
      );
    } else if (url === integrityUrl) {
      source = replaceOnce(
        readFileSync(fileURLToPath(url), "utf8"),
        "runCheck(step.value);",
        "if (step.value.check === 'full') globalThis.__indexAdmissionMeasure.fullChecks++; runCheck(step.value);",
      );
    }
    return source === undefined
      ? nextLoad(url, context)
      : {
          format: "module",
          source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
          shortCircuit: true,
        };
  },
});
if (values.mode === "run") {
  assert(!existsSync(root), "Use a fresh directory; existing data is never replaced");
  mkdirSync(root, { recursive: true });
  writeFileSync(options.env.OPENCLAW_CONFIG_PATH, "{}\n");
  const outputs: unknown[] = [];
  const child = (mode: string, arm = "candidate", allocation = false) => {
    const args = [
      "--expose-gc",
      "--import",
      fileURLToPath(new URL("../tsx.mjs", import.meta.url)),
      fileURLToPath(import.meta.url),
      "--state-dir",
      root,
      "--mode",
      mode,
      "--arm",
      arm,
      "--rows",
      String(number("rows")),
      "--payload-bytes",
      String(number("payload-bytes")),
    ];
    if (values["baseline-source"]) {
      args.push("--baseline-source", path.resolve(values["baseline-source"]));
    }
    if (allocation) {
      args.push("--allocation");
    }
    const result = spawnSync("/usr/bin/time", ["-p", process.execPath, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    assert.equal(result.status, 0, `${mode}/${arm} failed`);
    const line = result.stdout.split("\n").findLast((entry) => entry.startsWith("MEASURE "));
    assert(line, `${mode} emitted no measurement`);
    const row = JSON.parse(line.slice(8));
    const timing = /real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s+([\d.]+)/u.exec(result.stderr);
    assert(timing, "External process CPU measurement missing");
    Object.assign(row, {
      totalProcessWallMs: Number(timing[1]) * 1000,
      totalProcessCpuMs: (Number(timing[2]) + Number(timing[3])) * 1000,
    });
    outputs.push(row);
    writeFileSync(path.join(root, "measurements.json"), JSON.stringify(outputs, null, 2) + "\n");
  };
  child("seed");
  for (let control = 0; control < 2; control++) {
    child("prepare");
    child("sample", "control");
  }
  for (const allocation of [false, true]) {
    for (let sample = 0; sample < number("samples"); sample++) {
      for (const arm of sample % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
        child("prepare");
        child("sample", arm, allocation);
      }
    }
  }
} else {
  const { readSqliteCleanCloseSeal, writeSqliteCleanCloseSeal } =
    await import("../../src/infra/sqlite-clean-close-seal.js");
  const { sqliteDatabaseSealSchemaFor } =
    await import("../../src/state/openclaw-database-seal-schema.js");
  const {
    openOpenClawAgentDatabase,
    runOpenClawAgentWriteTransaction,
    closeOpenClawAgentDatabasesAsync,
  } = await import("../../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  const record = (row: unknown) => console.log(`MEASURE ${JSON.stringify(row)}`);
  const census = (db: OpenClawAgentDatabase["db"]) => {
    const counts = Object.fromEntries(
      [
        "session_nodes",
        "session_windows",
        "transcript_events",
        "session_input_completions",
        "conversation_deliveries",
      ].map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n]),
    );
    const digest = createHash("sha256");
    for (const sql of [
      "SELECT * FROM session_nodes ORDER BY session_key",
      "SELECT * FROM session_input_completions ORDER BY session_id,idempotency_key",
      "SELECT * FROM conversation_deliveries ORDER BY operation_id",
      "SELECT * FROM transcript_events WHERE session_id='synthetic-42' ORDER BY seq",
    ]) {
      for (const row of db.prepare(sql).iterate()) {
        digest.update(JSON.stringify(row)).update("\n");
      }
    }
    return { counts, digest: digest.digest("hex") };
  };
  if (values.mode === "prepare") {
    {
      using db = new DatabaseSync(options.path);
      for (const index of indexes) {
        db.exec(`DROP INDEX IF EXISTS ${index}`);
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    const proof = JSON.parse(readFileSync(path.join(root, "seed-proof.json"), "utf8"));
    assert(
      writeSqliteCleanCloseSeal(
        options.path,
        "prior-index-catalog",
        statSync(options.path, { bigint: true }),
        {
          ...proof,
          identity: {
            ...sqliteDatabaseSealSchemaFor("agent")!.identity,
            schema: "prior-index-catalog",
          },
        },
      ),
    );
    record({ phase: "prepare", bytes: statSync(options.path).size });
  } else if (values.mode === "seed") {
    const { db } = openOpenClawAgentDatabase(options);
    const key = (i: number) => `agent:main:synthetic-${i}`;
    const id = (i: number) => `synthetic-${i}`;
    runOpenClawAgentWriteTransaction(() => {
      const node = db.prepare(
        "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES(?,?,?,1,1)",
      );
      const window = db.prepare(
        "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
      );
      for (let i = 0; i < 10000; i++) {
        node.run(key(i), id(i), JSON.stringify({ sessionId: id(i), updatedAt: 1 }));
        window.run(id(i), key(i));
      }
      const complete = db.prepare(
        "INSERT INTO session_input_completions(session_key,session_id,idempotency_key,run_id,request_hash,outcome_json,succeeded,completed_at) VALUES(?,?,?,?,?,?,1,1)",
      );
      for (let i = 0; i < 12497; i++) {
        complete.run(
          key(i % 10000),
          id(i % 10000),
          `key-${i}`,
          `run-${i}`,
          "synthetic",
          JSON.stringify({ synthetic: "x".repeat(4096) }),
        );
      }
      db.exec(
        "INSERT INTO conversations(conversation_id,channel,account_id,kind,peer_id,delivery_target,created_at,updated_at) VALUES('conversation','synthetic','synthetic','direct','synthetic','synthetic',1,1)",
      );
      const delivery = db.prepare(
        "INSERT INTO conversation_deliveries(operation_id,operation_kind,conversation_id,source_session_key,message_hash,status,created_at,updated_at) VALUES(?,'send','conversation',?,'synthetic','sent',1,1)",
      );
      for (let i = 0; i < 14; i++) {
        delivery.run(`delivery-${i}`, key(i));
      }
    }, options);
    const event = db.prepare(
      "INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,message_role) VALUES(?,?,?,1,'message','toolResult')",
    );
    const payload = JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: "synthetic "
              .repeat(Math.ceil(number("payload-bytes") / 10))
              .slice(0, number("payload-bytes")),
          },
        ],
      },
    });
    const started = performance.now();
    for (let offset = 0; offset < number("rows"); offset += 2000) {
      runOpenClawAgentWriteTransaction(
        () => {
          for (let i = offset; i < Math.min(offset + 2000, number("rows")); i++) {
            event.run(id(i % 10000), Math.floor(i / 10000) + 1, payload);
          }
        },
        options,
        { operationLabel: "benchmark.seed" },
      );
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (offset % 50000 === 0) {
        console.log(
          JSON.stringify({
            phase: "seed-progress",
            rows: offset,
            elapsedMs: performance.now() - started,
          }),
        );
      }
    }
    writeFileSync(path.join(root, "census.json"), JSON.stringify(census(db)));
    await closeOpenClawAgentDatabasesAsync();
    const proof = readSqliteCleanCloseSeal(options.path, statSync(options.path, { bigint: true }));
    assert(proof, "Seed must close with a real verification receipt");
    writeFileSync(path.join(root, "seed-proof.json"), JSON.stringify(proof));
    record({
      phase: "fixture",
      bytes: statSync(options.path).size,
      rows: number("rows"),
      sessions: 10000,
      completions: 12497,
      deliveries: 14,
      node: process.version,
      seedMs: performance.now() - started,
    });
  } else {
    const inspector = new Session();
    inspector.connect();
    global.gc();
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const load = loadavg();
    const cpuBefore = process.cpuUsage();
    const threadBefore = process.threadCpuUsage();
    const rssBefore = process.memoryUsage().rss;
    observation.fullChecks = 0;
    observation.diagnostics = undefined;
    const started = performance.now();
    const opened = openOpenClawAgentDatabase(options);
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const thread = process.threadCpuUsage(threadBefore);
    const heap = values.allocation ? await inspector.post("HeapProfiler.stopSampling") : undefined;
    inspector.disconnect();
    assert.equal(
      opened.db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name IN (?,?)")
        .get(...indexes)?.n,
      2,
    );
    assert.deepEqual(
      census(opened.db),
      JSON.parse(readFileSync(path.join(root, "census.json"), "utf8")),
    );
    assert.equal(observation.fullChecks, values.arm === "baseline" ? 1 : 0);
    record({
      fullChecks: observation.fullChecks,
      diagnostics: observation.diagnostics,
      phase: values.allocation ? "allocation" : "timing",
      arm: values.arm,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      threadCpuMs: (thread.user + thread.system) / 1000,
      allocatedBytes: heap ? sumSampledHeapBytes(heap.profile.head) : undefined,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      load,
    });
    await closeOpenClawAgentDatabasesAsync();
  }
  await closeOpenClawStateDatabaseAsync();
}
