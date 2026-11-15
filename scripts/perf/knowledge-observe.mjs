/**
 * Knowledge observe owner benchmark (synthetic SQLite and Markdown only).
 * Run from the repo root:
 * ITERATIONS=2000 node --expose-gc --import ./scripts/tsx.mjs scripts/perf/knowledge-observe.mjs [baseline-storage-base.ts]
 * Repeat in AB/BA order; SAMPLE=1 measures allocation separately; PROFILE_SQL=1
 * attributes statement time in an instrumented pass. RECORDS defaults to 1000.
 * TOMBSTONES adds unavailable observation rows to exercise depleted stores.
 *
 * Assumed store: 1,000 current 4 KiB records, ten revisions per record and 10,000
 * completed journal plans. These are scale assumptions, not measured Team counts.
 * Setup and digest checks are excluded. The public scanner validates the fixture
 * first; timed calls isolate its synchronous observe callback with unchanged
 * records, as during a rescan after an unrelated file changes. Git is disabled.
 * This measures worker CPU and JS allocation, not Gateway main-thread latency or
 * native SQLite allocation. Sampling includes objects collected during the run.
 * State and returned-record digests must match between base and candidate.
 * With at least three records, post-timing edits/rename/delete/restore run through
 * the public scanner with a fixed ISO clock and produce a second state digest.
 * Fixture files live under .local and are removed even after an assertion fails.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
const repo = process.cwd(),
  owner = path.join(repo, "extensions/knowledge/src");
const source = path.resolve(process.argv[2] || path.join(owner, "storage-base.ts"));
registerHooks({
  resolve(s, c, next) {
    if (s.startsWith("openclaw/plugin-sdk/")) {
      return next(pathToFileURL(path.join(repo, "src/plugin-sdk", s.slice(20) + ".ts")).href, c);
    }
    if (c.parentURL === pathToFileURL(source).href && s.startsWith("./")) {
      return next(pathToFileURL(path.join(owner, s.replace(/\.js$/, ".ts"))).href, c);
    }
    return next(s, c);
  },
});
const { StorageBase } = await import(pathToFileURL(source).href);
const { SqliteIdentityStore } = await import(
  pathToFileURL(path.join(owner, "identity-store.ts")).href
);
const { EvidenceInspector } = await import(
  pathToFileURL(path.join(owner, "evidence-files.ts")).href
);
const { digest } = await import(pathToFileURL(path.join(owner, "scan-primitives.ts")).href);
fs.mkdirSync(path.join(repo, ".local"), { recursive: true });
const dir = fs.mkdtempSync(path.join(repo, ".local/knowledge-observe-"));
const n = Number(process.env.RECORDS || 1000),
  iterations = Number(process.env.ITERATIONS || 10);
const tombstones = Number(process.env.TOMBSTONES || 0);
assert.ok(Number.isSafeInteger(n) && n > 0);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
assert.ok(Number.isSafeInteger(tombstones) && tombstones >= 0);
const stamp = "2026-01-01T00:00:00.000Z";
const manifest = {
  format: "knowledge-vault-v2",
  vaultId: "00000000-0000-4000-8000-000000000001",
  generation: 0,
  publicationId: "00000000-0000-4000-8000-000000000002",
};
fs.mkdirSync(path.join(dir, "private", "notes"), { recursive: true });
fs.writeFileSync(path.join(dir, "vault.json"), JSON.stringify(manifest));
const cfg = {
  root: dir,
  statePath: path.join(dir, "state.sqlite"),
  vaultId: manifest.vaultId,
  publicationId: manifest.publicationId,
  writesEnabled: false,
};
const access = { scope: { visibility: "private" }, agentId: "synthetic", assertCurrent() {} };
const records = Array.from({ length: n }, (_, i) => {
  const id = `record-${String(i).padStart(6, "0")}`,
    body = "Synthetic observation body.\n".repeat(150);
  const metadata = {
    format: "knowledge-record-v1",
    id,
    revision: 1,
    kind: "page",
    type: "note",
    title: id,
    scope: access.scope,
    recorded_at: stamp,
    updated_at: stamp,
    lifecycle: "active",
  };
  const raw = `---\n${JSON.stringify(metadata)}\n---\n${body}`;
  fs.writeFileSync(path.join(dir, "private", "notes", id + ".md"), raw);
  return {
    id,
    path: "notes/" + id + ".md",
    hash: digest(raw),
    revision: 1,
    body,
    raw,
    metadata,
    kind: "page",
    type: "note",
    title: id,
    lifecycle: "active",
    valid: true,
  };
});
let tracking = false;
const timings = new Map();
class Store extends SqliteIdentityStore {
  withDatabase(run) {
    return super.withDatabase((db) => {
      const prepare = db.prepare.bind(db);
      db.prepare = (sql) => {
        const s = prepare(sql);
        return new Proxy(s, {
          get(t, k) {
            const v = Reflect.get(t, k, t);
            if (typeof v !== "function") {
              return v;
            }
            return (...args) => {
              const start = performance.now();
              try {
                return Reflect.apply(v, t, args);
              } finally {
                if (tracking) {
                  const entry = timings.get(sql) || { count: 0, ms: 0 };
                  entry.count++;
                  entry.ms += performance.now() - start;
                  timings.set(sql, entry);
                }
              }
            };
          },
        });
      };
      return run(db);
    });
  }
}
const store = process.env.PROFILE_SQL
  ? new Store(cfg.statePath)
  : new SqliteIdentityStore(cfg.statePath);
try {
  await store.registerIfAbsent(`store:${manifest.vaultId}`, manifest);
  store.withDatabase((db) => {
    db.exec("BEGIN");
    const h = db.prepare(
      "INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw,agent_id) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const o = db.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?)");
    const m = db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)");
    for (let rev = 0; rev < 10; rev++) {
      for (const r of records) {
        h.run(
          "private",
          r.id,
          "agent",
          stamp,
          r.path,
          rev + 1,
          rev === 9 ? r.hash : `old-${rev}`,
          r.raw,
          "synthetic",
        );
      }
    }
    for (const r of records) {
      o.run("private", r.id, r.path, r.hash, 10, r.raw);
    }
    for (let i = 0; i < 10000; i++) {
      m.run(
        "private",
        `mutation-${i}`,
        "synthetic",
        "published",
        JSON.stringify({ body: records[0].body }),
        "{}",
      );
    }
    for (let i = 0; i < tombstones; i++) {
      o.run("private", `deleted-${i}`, `notes/deleted-${i}.md`, "", 2, records[0].raw);
    }
    db.exec("COMMIT");
  });
  if (process.env.PROFILE_SQL) {
    store.withDatabase((db) =>
      console.error(
        JSON.stringify(
          db
            .prepare(
              "EXPLAIN QUERY PLAN SELECT provenance,agent_id,sequence FROM history WHERE scope=? AND id=? AND hash=? ORDER BY sequence DESC LIMIT 1",
            )
            .all("private", "record-000000", records[0].hash),
        ),
      ),
    );
  }
  const storage = new StorageBase(cfg, store),
    evidence = new EvidenceInspector(path.join(dir, "private"));
  // First reproduce through the public scanner; subsequent samples isolate the synchronous observe owner.
  const scanned = await storage.run(access, (v) => v.scan());
  assert.equal(scanned.records.length, n);
  assert.equal(scanned.issues.length, 0, JSON.stringify(scanned.issues.slice(0, 2)));
  const observe = Reflect.get(storage, "observe");
  assert.equal(typeof observe, "function");
  const run = () => Reflect.apply(observe, storage, [records, access, evidence]);
  const snapshot = () =>
    store.withDatabase((db) =>
      digest(
        JSON.stringify(
          [
            "observations",
            "history",
            "mutations",
            "lifecycle_guards_v1",
            "keyword_withdrawals_v1",
          ].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
        ),
      ),
    );
  const before = snapshot();
  run();
  globalThis.gc?.();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const collections = [];
  const observer = new PerformanceObserver((batch) => collections.push(...batch.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const inspector = process.env.SAMPLE ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpu = process.cpuUsage(),
    start = performance.now(),
    hostLoad = loadavg();
  tracking = true;
  for (let i = 0; i < iterations; i++) {
    run();
  }
  tracking = false;
  const used = process.cpuUsage(cpu),
    wallMs = performance.now() - start;
  const memory = process.memoryUsage();
  const allocation = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  collections.push(...observer.takeRecords());
  observer.disconnect();
  const gc = collections.filter(
    (entry) => entry.startTime >= start && entry.startTime < start + wallMs,
  );
  const sum = (node) => node.selfSize + node.children.reduce((s, c) => s + sum(c), 0);
  const after = snapshot();
  assert.equal(after, before);
  let mutationDigest;
  if (records.length >= 3) {
    const [edited, renamed, removed] = records;
    mock.timers.enable({ apis: ["Date"], now: new Date(stamp) });
    try {
      fs.writeFileSync(path.join(dir, "private", edited.path), edited.raw + "External edit.\n");
      fs.renameSync(
        path.join(dir, "private", renamed.path),
        path.join(dir, "private", renamed.path + "-renamed.md"),
      );
      fs.rmSync(path.join(dir, "private", removed.path));
      await storage.run(access, (vault) => vault.scan());
      fs.writeFileSync(path.join(dir, "private", removed.path), removed.raw);
      const restored = await storage.run(access, (vault) => vault.scan());
      assert.equal(restored.issues.length, 0);
      mutationDigest = digest(snapshot() + JSON.stringify(restored.records));
    } finally {
      mock.timers.reset();
    }
  }
  console.log(
    JSON.stringify({
      source,
      records: n,
      tombstones,
      history: n * 10,
      mutations: 10000,
      iterations,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes: allocation ? sum(allocation.profile.head) : null,
      digest: after,
      mutationDigest,
      recordDigest: digest(JSON.stringify(records)),
      hostLoad,
      memory,
      gcCount: gc.length,
      gcTotalMs: gc.reduce((total, entry) => total + entry.duration, 0),
      gcMaxMs: gc.reduce((max, entry) => Math.max(max, entry.duration), 0),
      sql: [...timings].toSorted((a, b) => b[1].ms - a[1].ms),
    }),
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
