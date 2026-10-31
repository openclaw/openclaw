/**
 * Synthetic cold-navigation Doctor benchmark (never use operator state).
 * Reuse the supplied buf634 synthetic cold fixture (fixture.json format "buf634-v1").
 * node --import ./scripts/tsx.mjs scripts/perf/cold-navigation-backfill.mjs \
 *   --state-dir .local/cold-fixture --output .local/cold-result.json --reset
 * --revision <commit> pins changed source modules from git without another checkout.
 * --profile cpu|allocation runs a separate diagnostic pass; default is untraced.
 * --mode digest|pages verifies exact navigation rows or head/middle/tail cold pages.
 * Compare base/candidate on identical copied fixtures; reset deletes only synthetic
 * cold navigation, retaining archives. Per-archive transactions and backups remain real.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    mode: { type: "string", default: "measure" },
    revision: { type: "string" },
    profile: { type: "string" },
    reset: { type: "boolean" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
assert(["measure", "digest", "pages"].includes(values.mode), "Unknown mode");
assert(!values.profile || ["cpu", "allocation"].includes(values.profile), "Unknown profile");
const root = fs.realpathSync(values["state-dir"]);
const output = path.resolve(values.output);
const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(fixture.format, "buf634-v1", "Refusing non-synthetic state");
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dbpath = path.join(root, "agent.sqlite");
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  TMPDIR: path.join(root, "tmp"),
  XDG_CACHE_HOME: path.join(os.homedir(), "Library/Caches/openclaw-cold-navigation-bench"),
});
fs.mkdirSync(path.dirname(output), { recursive: true });
const git = (...args) =>
  execFileSync("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(process.platform === "darwin"
        ? { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" }
        : {}),
    },
  }).trim();
const revision = git("rev-parse", "--verify", `${values.revision ?? "HEAD"}^{commit}`);
const sourceDiffSha256 = values.revision
  ? null
  : createHash("sha256")
      .update(git("diff", "--binary", revision, "--", "src"))
      .digest("hex");
const pinned = new Map();
if (values.revision) {
  for (const file of git("diff", "--name-only", revision, "--", "src")
    .split("\n")
    .filter(Boolean)) {
    if (git("ls-tree", "--name-only", revision, "--", file)) {
      pinned.set(
        pathToFileURL(path.join(sourceRoot, file)).href,
        stripTypeScriptTypes(git("show", `${revision}:${file}`)),
      );
    }
  }
}
function rawRead(read) {
  const db = new DatabaseSync(dbpath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function digests() {
  return rawRead((db) =>
    Object.fromEntries(
      Object.entries({
        transcript_events: "session_id,seq",
        transcript_event_identities: "session_id,event_id",
        session_transcript_active_events: "session_id,active_position",
        session_transcript_index_state: "session_id",
      }).map(([table, order]) => {
        const hash = createHash("sha256");
        let count = 0;
        for (const row of db
          .prepare(`SELECT * FROM ${table} WHERE session_id IN
      (SELECT session_id FROM session_transcript_cold_archives) ORDER BY ${order}`)
          .iterate()) {
          hash.update(JSON.stringify(row));
          hash.update("\n");
          count++;
        }
        return [table, { count, sha256: hash.digest("hex") }];
      }),
    ),
  );
}
if (values.reset) {
  assert.equal(values.mode, "measure", "--reset requires measure mode");
  const db = new DatabaseSync(dbpath);
  try {
    db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
    DELETE FROM transcript_events WHERE session_id IN (SELECT session_id FROM session_transcript_cold_archives);
    DELETE FROM session_transcript_index_state WHERE session_id IN (SELECT session_id FROM session_transcript_cold_archives);
    COMMIT; PRAGMA wal_checkpoint(TRUNCATE);`);
  } finally {
    db.close();
  }
}
function archiveManifest() {
  return rawRead((db) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          db
            .prepare(`SELECT
    session_id,generation,archive_name,archive_sha256,event_count,raw_bytes,archive_bytes,last_seq,storage
    FROM session_transcript_cold_archives ORDER BY session_id`)
            .all(),
        ),
      )
      .digest("hex"),
  );
}
const archives = [];
let backupMs = 0;
let armed = false;
let compressions = 0;
globalThis.coldNavigationBenchmark = {
  transaction(args, invoke) {
    if (!armed || args[2]?.operationLabel !== "session.cold-navigation-migration") {
      return invoke(...args);
    }
    const started = performance.now();
    const cpu = process.threadCpuUsage();
    try {
      return invoke(...args);
    } finally {
      archives.push({
        elapsedMs: performance.now() - started,
        cpu: process.threadCpuUsage(cpu),
        rss: process.memoryUsage.rss(),
      });
      if (archives.length % 25 === 0) {
        console.error(`Completed ${archives.length} archives`);
      }
    }
  },
  backup(args, invoke) {
    const started = performance.now();
    try {
      return invoke(...args);
    } finally {
      if (armed) {
        backupMs += performance.now() - started;
      }
    }
  },
};
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    let source = pinned.get(url) ?? result.source;
    const spec = [
      ["sqlite-transaction.ts", "runSqliteImmediateTransactionSync", "transaction"],
      ["sqlite-index-recovery.ts", "backupDoctorSqliteRepair", "backup"],
    ].find(([file]) => url.endsWith(`/${file}`));
    if (spec) {
      const [, name, wrapper] = spec;
      source = String(source);
      const declaration = `function ${name}`;
      assert.equal(source.split(declaration).length, 2, `Expected one declaration: ${name}`);
      const exported = source.includes(`export ${declaration}`);
      source = source.replace(
        exported ? `export ${declaration}` : declaration,
        `function benchmarkOriginal_${name}`,
      );
      source += `\n${exported ? "export " : ""}function ${name}(...args) { return globalThis.coldNavigationBenchmark.${wrapper}(args, benchmarkOriginal_${name}); }`;
    }
    return { ...result, source };
  },
});
const compress = zlib.zstdCompressSync;
zlib.zstdCompressSync = (...args) => {
  if (armed) {
    compressions++;
  }
  return compress(...args);
};
syncBuiltinESMExports();
const importSource = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
const { closeOpenClawAgentDatabasesAsync } = await importSource("src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await importSource("src/state/openclaw-state-db.ts");
let report;
try {
  if (values.mode === "digest") {
    report = { revision, digests: digests() };
  } else if (values.mode === "pages") {
    const rows = rawRead((db) =>
      db
        .prepare(
          "SELECT session_id,event_count FROM session_transcript_cold_archives ORDER BY session_id",
        )
        .all(),
    );
    const { createReadonlySessionHistoryReader } = await importSource(
      "src/gateway/session-history-readonly-reader.ts",
    );
    const { OpenClawAgentDatabaseReadOnlyScope } = await importSource(
      "src/state/openclaw-agent-db-readonly-scope.ts",
    );
    const manifestBefore = archiveManifest();
    const owner = new OpenClawAgentDatabaseReadOnlyScope();
    const hash = createHash("sha256");
    let pages = 0;
    let events = 0;
    try {
      for (const row of rows) {
        const sessionId = row.session_id;
        const sessionKey = `agent:synthetic:${sessionId}`;
        const target = {
          database: { agentId: "synthetic", path: dbpath },
          transcript: {
            agentId: "synthetic",
            sessionId,
            sessionKey,
            sessionFile: sessionKey,
            storePath: dbpath,
          },
        };
        const reader = createReadonlySessionHistoryReader(target);
        for (const offset of [
          0,
          Math.floor(row.event_count / 2),
          Math.max(0, row.event_count - 5),
        ]) {
          const page = owner.run(target.database, () =>
            reader.readHistoryEventPage({ offset, maxMessages: 5, maxBytes: 128 * 1024 }),
          );
          hash.update(JSON.stringify(page));
          pages++;
          events += page.events.length;
        }
      }
    } finally {
      owner.close();
    }
    const manifestAfter = archiveManifest();
    assert.equal(manifestAfter, manifestBefore, "Cold reads restored or changed archives");
    report = {
      revision,
      archives: rows.length,
      pages,
      events,
      sha256: hash.digest("hex"),
      archiveManifestSha256: manifestAfter,
    };
  } else {
    const { migrateSessionColdNavigation } = await importSource(
      "src/infra/state-migrations.cold-navigation.ts",
    );
    const { withSqliteReadOnlyWorkerScope } = await importSource(
      "src/infra/sqlite-readonly-worker.ts",
    );
    const inspector = new Session();
    inspector.connect();
    if (values.profile === "cpu") {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    if (values.profile === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const workload = rawRead((db) =>
      db
        .prepare(`SELECT count(*) archives, coalesce(sum(event_count), 0) events
      FROM session_transcript_cold_archives a WHERE NOT EXISTS
      (SELECT 1 FROM transcript_events e WHERE e.session_id=a.session_id)`)
        .get(),
    );
    const manifestBefore = archiveManifest();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const loadBefore = os.loadavg();
    const memoryBefore = process.memoryUsage();
    armed = true;
    const result = await withSqliteReadOnlyWorkerScope(
      () =>
        migrateSessionColdNavigation({
          preparedTargets: [
            { agentId: "synthetic", path: dbpath, realPath: fs.realpathSync(dbpath) },
          ],
          env: process.env,
        }),
      { signal: new AbortController().signal, deadlineOwnedByCaller: true },
    );
    armed = false;
    report = {
      revision,
      elapsedMs: performance.now() - started,
      threadCpu: process.threadCpuUsage(cpu),
      backupMs,
      loadBefore,
      loadAfter: os.loadavg(),
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      resourceUsage: process.resourceUsage(),
      workload,
      compressions,
      result,
      archives,
    };
    if (values.profile) {
      const { profile } = await inspector.post(
        values.profile === "cpu" ? "Profiler.stop" : "HeapProfiler.stopSampling",
      );
      if (values.profile === "allocation") {
        const sumBackfill = (node, selected = false) => {
          const inside =
            selected ||
            node.callFrame.functionName.includes("backfillSessionColdNavigationInTransaction");
          return (
            (inside ? node.selfSize : 0) +
            node.children.reduce((sum, child) => sum + sumBackfill(child, inside), 0)
          );
        };
        report.backfillSampledAllocationBytes = sumBackfill(profile.head);
      }
      fs.writeFileSync(
        `${output}.${values.profile === "cpu" ? "cpuprofile" : "heapprofile"}`,
        JSON.stringify(profile),
      );
    }
    inspector.disconnect();
    report.digests = digests();
    report.archiveManifestSha256 = archiveManifest();
    assert.equal(report.archiveManifestSha256, manifestBefore, "Doctor changed source archives");
  }
  report.sourceDiffSha256 = sourceDiffSha256;
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      ...report,
      archives: Array.isArray(report.archives) ? report.archives.length : report.archives,
    }),
  );
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
