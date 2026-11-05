// Synthetic source-CLI benchmark: node scripts/perf/doctor-sqlite-inspection.mjs --samples 5.
// macOS needs cc; Linux needs cc and uses LD_PRELOAD. No operator state is read.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const script = fileURLToPath(import.meta.url);
const repo = fs.realpathSync(new URL("../..", import.meta.url));
const { values } = parseArgs({
  options: {
    child: { type: "string" },
    samples: { type: "string", default: "5" },
    mib: { type: "string", default: "256" },
    out: { type: "string" },
  },
});
const source = (name) => pathToFileURL(path.join(repo, name)).href;
if (values.child) {
  const fixtureRoot = process.env.DOCTOR_BENCH_ROOT;
  if (
    !fixtureRoot ||
    !process.env.HOME?.startsWith(`${fixtureRoot}${path.sep}`) ||
    !process.env.OPENCLAW_STATE_DIR?.startsWith(`${fixtureRoot}${path.sep}`)
  ) {
    throw new Error("Child mode requires controller-owned isolated state");
  }
  await import(source("scripts/tsx.mjs"));
  if (values.child === "seed") {
    const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } = await import(
      source("src/state/openclaw-state-db.ts")
    );
    const { closeOpenClawAgentDatabasesAsync, openOpenClawAgentDatabase } = await import(
      source("src/state/openclaw-agent-db.ts")
    );
    const shared = openOpenClawStateDatabase();
    const agent = openOpenClawAgentDatabase({ agentId: "main" });
    // Deliberate opaque payload makes integrity scans and snapshots pay real I/O.
    for (const database of [shared, agent]) {
      database.db.exec(
        "CREATE TABLE benchmark_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)",
      );
      const insert = database.db.prepare(
        "INSERT INTO benchmark_payload(payload) VALUES (zeroblob(1048576))",
      );
      database.db.exec("BEGIN");
      for (let index = 0; index < Number(values.mib) / 2; index++) {
        insert.run();
      }
      database.db.exec("COMMIT");
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  } else {
    const { installDatabaseProcessRole } = await import(
      source("src/infra/database-engine/admission-scope.ts")
    );
    installDatabaseProcessRole("cli-oneshot");
    const { runCli } = await import(source("src/cli/run-main.ts"));
    const { withCliProcessScope } = await import(source("src/cli/runtime-cleanup-scope.ts"));
    const { runCliWithExitFinalization } = await import(source("src/cli/one-shot-exit.ts"));
    await runCliWithExitFinalization({
      run: () =>
        withCliProcessScope(() =>
          runCli([process.execPath, path.join(repo, "openclaw.mjs"), "doctor", "--lint", "--json"]),
        ),
      onError(error) {
        console.error(error);
        process.exitCode = 2;
      },
    });
  }
} else {
  const samples = Number(values.samples),
    mib = Number(values.mib);
  if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(mib) || mib < 2) {
    throw new Error("Positive samples and mib >= 2 required");
  }
  const temp =
    process.platform === "darwin"
      ? spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim()
      : os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temp, "doctor-sqlite-bench-")));
  const env = {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: path.join(root, "tmp"),
    NODE_DISABLE_COMPILE_CACHE: "1",
    DOCTOR_BENCH_ROOT: root,
  };
  for (const directory of Object.values(env).filter((value) => value.startsWith(root))) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(
    path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
    JSON.stringify({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        entries: { main: { workspace: path.join(root, "workspace") } },
      },
      plugins: { enabled: false },
      memory: { search: { enabled: false } },
    }),
  );
  const execute = (args, extra = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: repo,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    const seed = execute(["--child", "seed", "--mib", String(mib)]);
    if (seed.status !== 0) {
      throw new Error(`Fixture setup failed: ${seed.stderr}`);
    }
    const c = path.join(root, "reads.c"),
      library = path.join(root, process.platform === "darwin" ? "reads.dylib" : "reads.so");
    fs.writeFileSync(
      c,
      String.raw`
#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sys/stat.h>
#include <dlfcn.h>
static _Atomic uint64_t reads = 0, bytes = 0, sqliteReads = 0, sqliteBytes = 0;
static pthread_mutex_t paths_lock = PTHREAD_MUTEX_INITIALIZER;
static struct { char name[4096]; uint64_t reads, bytes; } paths[512];
static int paths_count = 0;
static void record(int fd, ssize_t n) {
 struct stat s;
 if (n < 0 || fstat(fd, &s) != 0 || !S_ISREG(s.st_mode)) return;
 atomic_fetch_add(&reads, 1); atomic_fetch_add(&bytes, n);
 char filename[4096] = {0};
#ifdef __APPLE__
 if (fcntl(fd, F_GETPATH, filename) != 0) return;
#else
 char link[64]; snprintf(link,sizeof(link),"/proc/self/fd/%d",fd);
 ssize_t length = readlink(link,filename,sizeof(filename)-1); if (length < 0) return; filename[length] = 0;
#endif
 char *suffix = NULL;
 for (char *next = filename; (next = strstr(next,".sqlite")); next += 7) suffix = next + 7;
 if (suffix && (!*suffix || strcmp(suffix,"-wal")==0 || strcmp(suffix,"-shm")==0 || strcmp(suffix,"-journal")==0 || strcmp(suffix,".partial")==0 || strcmp(suffix,".partial-wal")==0 || strcmp(suffix,".partial-shm")==0 || strcmp(suffix,".partial-journal")==0 || strcmp(suffix,".seal")==0)) {
  atomic_fetch_add(&sqliteReads,1); atomic_fetch_add(&sqliteBytes,n);
  pthread_mutex_lock(&paths_lock);
  int i; for(i=0;i<paths_count;i++) if(strcmp(paths[i].name,filename)==0) break;
  if(i==paths_count && paths_count<512) { snprintf(paths[i].name,sizeof(paths[i].name),"%s",filename); paths_count++; }
  if(i<512) { paths[i].reads++; paths[i].bytes+=n; }
  pthread_mutex_unlock(&paths_lock);
 }
}
#ifdef __APPLE__
static ssize_t counted_read(int fd, void *b, size_t n) { ssize_t r = read(fd,b,n); record(fd,r); return r; }
static ssize_t counted_pread(int fd, void *b, size_t n, off_t o) { ssize_t r = pread(fd,b,n,o); record(fd,r); return r; }
#define INTERPOSE(replacement, replacee) __attribute__((used)) static struct { const void *replacement; const void *replacee; } interpose_##replacee __attribute__((section("__DATA,__interpose"))) = { (const void *)&replacement, (const void *)&replacee };
INTERPOSE(counted_read,read)
INTERPOSE(counted_pread,pread)
#else
ssize_t read(int fd, void *b, size_t n) { static ssize_t (*original)(int,void*,size_t); if (!original) original = dlsym(RTLD_NEXT,"read"); ssize_t r = original(fd,b,n); record(fd,r); return r; }
ssize_t pread(int fd, void *b, size_t n, off_t o) { static ssize_t (*original)(int,void*,size_t,off_t); if (!original) original = dlsym(RTLD_NEXT,"pread"); ssize_t r = original(fd,b,n,o); record(fd,r); return r; }
#ifdef __GLIBC__
ssize_t pread64(int fd, void *b, size_t n, off64_t o) { static ssize_t (*original)(int,void*,size_t,off64_t); if (!original) original = dlsym(RTLD_NEXT,"pread64"); ssize_t r = original(fd,b,n,o); record(fd,r); return r; }
#endif
#endif
static void quote(FILE *f, const char *s) { fputc('"',f); for (; *s; s++) { if (*s == '"' || *s == '\\') fputc('\\',f); if ((unsigned char)*s >= 32) fputc(*s,f); } fputc('"',f); }
__attribute__((destructor)) static void report(void) {
 const char *root = getenv("DOCTOR_READ_COUNTS"); if (!root) return;
 char name[4096]; snprintf(name,sizeof(name),"%s/reads-%d.json",root,getpid());
 FILE *f = fopen(name,"w"); if (!f) return;
 fprintf(f,"{\"reads\":%llu,\"bytes\":%llu,\"sqliteReads\":%llu,\"sqliteBytes\":%llu,\"paths\":[",(unsigned long long)atomic_load(&reads),(unsigned long long)atomic_load(&bytes),(unsigned long long)atomic_load(&sqliteReads),(unsigned long long)atomic_load(&sqliteBytes));
 for(int i=0;i<paths_count;i++) { if(i) fputc(',',f); fprintf(f,"{\"path\":"); quote(f,paths[i].name); fprintf(f,",\"reads\":%llu,\"bytes\":%llu}",(unsigned long long)paths[i].reads,(unsigned long long)paths[i].bytes); }
 fprintf(f,"]}\n"); fclose(f);
}
`,
    );
    const compile = spawnSync(
      "cc",
      [
        ...(process.platform === "darwin" ? ["-dynamiclib"] : ["-shared", "-fPIC"]),
        "-O2",
        c,
        "-o",
        library,
        ...(process.platform === "darwin" ? [] : ["-ldl"]),
      ],
      { encoding: "utf8" },
    );
    if (compile.status !== 0) {
      throw new Error(`Read counter compilation failed: ${compile.stderr}`);
    }
    const observer = path.join(root, "sqlite-observer.cjs");
    fs.writeFileSync(
      observer,
      String.raw`
const fs = require("node:fs"), path = require("node:path"), sqlite = require("node:sqlite");
const Native = sqlite.DatabaseSync, databases = new Map();
sqlite.DatabaseSync = class extends Native {
  constructor(location, options) { super(location, options ?? {}); this.benchmarkLocation = String(location); const row = databases.get(this.benchmarkLocation) ?? { opens: 0, quickChecks: 0, statements: 0 }; row.opens++; databases.set(this.benchmarkLocation,row); }
  exec(sql) { const row = databases.get(this.benchmarkLocation); if (row) { row.statements++; if (/\b(?:quick_check|integrity_check)\b/i.test(sql)) row.quickChecks++; } return super.exec(sql); }
  prepare(sql) { const statement = super.prepare(sql), row = databases.get(this.benchmarkLocation); for (const method of ["all","get","iterate","run"]) { const original = statement[method]; statement[method] = function(...args) { if (row) { row.statements++; if (/\b(?:quick_check|integrity_check)\b/i.test(sql)) row.quickChecks++; } return original.apply(this,args); }; } return statement; }
};
require("node:module").syncBuiltinESMExports();
process.on("exit", () => fs.writeFileSync(path.join(process.env.DOCTOR_READ_COUNTS,"sqlite-"+process.pid+"-"+require("node:worker_threads").threadId+".json"), JSON.stringify({databases:[...databases]})));
`,
    );
    const rows = [];
    for (let index = 0; index < samples; index++) {
      const counts = path.join(root, `counts-${index}`);
      fs.mkdirSync(counts);
      const started = performance.now();
      const child = execute(["--child", "lint"], {
        DOCTOR_READ_COUNTS: counts,
        NODE_OPTIONS: `--require=${observer}`,
        [process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"]: library,
      });
      const elapsedMs = performance.now() - started;
      if (child.status !== 0 && child.status !== 1) {
        throw new Error(`Doctor failed (${child.status}): ${child.stderr} ${child.stdout}`);
      }
      const report = JSON.parse(child.stdout);
      if (!(report.checksRun > 0)) {
        throw new Error(`Doctor produced no lint report: ${child.stderr} ${child.stdout}`);
      }
      const native = fs
        .readdirSync(counts)
        .filter((name) => name.startsWith("reads-"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(counts, name), "utf8")));
      if (!native.length) {
        throw new Error("Native read observer did not load");
      }
      const observations = fs
        .readdirSync(counts)
        .filter((name) => name.startsWith("sqlite-"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(counts, name), "utf8")));
      const sqlite = observations.flatMap((entry) => entry.databases);
      const row = {
        sample: index,
        elapsedMs,
        exitCode: child.status,
        reads: native.reduce((sum, r) => sum + r.reads, 0),
        bytes: native.reduce((sum, r) => sum + r.bytes, 0),
        sqliteReads: native.reduce((sum, r) => sum + r.sqliteReads, 0),
        sqliteBytes: native.reduce((sum, r) => sum + r.sqliteBytes, 0),
        opens: sqlite.reduce((sum, [, r]) => sum + r.opens, 0),
        quickChecks: sqlite.reduce((sum, [, r]) => sum + r.quickChecks, 0),
        paths: native.flatMap((entry) => entry.paths),
        sqlite,
        stderr: child.stderr,
        stdout: child.stdout,
      };
      rows.push(row);
      console.error(
        JSON.stringify({
          sample: index,
          elapsedMs,
          reads: row.reads,
          bytes: row.bytes,
          sqliteReads: row.sqliteReads,
          sqliteBytes: row.sqliteBytes,
          opens: row.opens,
          quickChecks: row.quickChecks,
        }),
      );
    }
    const quantile = (key, p) =>
      rows.map((row) => row[key]).toSorted((a, b) => a - b)[Math.ceil(rows.length * p) - 1];
    const summary = {
      sourceHead: spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout.trim(),
      node: process.version,
      platform: process.platform,
      load: os.loadavg(),
      samples,
      mib,
      scope:
        "source runCli doctor --lint --json; fresh processes; OS cache not flushed; native regular-file read/pread counts across child processes (mmap page faults excluded)",
      median: Object.fromEntries(
        ["elapsedMs", "reads", "bytes", "sqliteReads", "sqliteBytes", "opens", "quickChecks"].map(
          (key) => [key, quantile(key, 0.5)],
        ),
      ),
      p95Ms: quantile("elapsedMs", 0.95),
      rows,
    };
    if (values.out) {
      fs.writeFileSync(values.out, JSON.stringify(summary, null, 2) + "\n");
    }
    console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
