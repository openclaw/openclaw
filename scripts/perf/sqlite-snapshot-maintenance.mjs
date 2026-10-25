// Source-level, synthetic-only count reproduction. This is not Gateway timing proof.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    harness: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.harness || !values.out) {
  throw new Error("Use --harness <frozen harness directory> --out <new directory>");
}
const repo = fs.realpathSync(new URL("../..", import.meta.url));
const out = path.resolve(values.out);
const internal = fs.realpathSync(path.join(homedir(), ".cache", "dbasync-campaign"));
if (!fs.realpathSync(path.dirname(out)).startsWith(`${internal}${path.sep}`)) {
  throw new Error("Output must be a new directory below internal campaign scratch");
}
const harness = fs.realpathSync(values.harness);
const hashes = JSON.parse(fs.readFileSync(`${harness}-frozen-hashes.json`, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, expected] of Object.entries(hashes)) {
  if (sha256(fs.readFileSync(path.join(harness, name))) !== expected) {
    throw new Error(`Frozen harness changed: ${name}`);
  }
}
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
if (head.status !== 0) {
  throw new Error("Cannot resolve measured source head");
}
fs.mkdirSync(out, { mode: 0o700 });
for (const name of ["home", "tmp", "cache", "state", "young-fixture", "empty-fixture"]) {
  fs.mkdirSync(path.join(out, name), { mode: 0o700 });
}
const env = {
  PATH: process.env.PATH,
  LANG: process.env.LANG ?? "en_US.UTF-8",
  HOME: path.join(out, "home"),
  TMPDIR: path.join(out, "tmp"),
  XDG_CACHE_HOME: path.join(out, "cache"),
  OPENCLAW_STATE_DIR: path.join(out, "state"),
  NODE_DISABLE_COMPILE_CACHE: "1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(out, "tmp", "bun-cache"),
  OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: path.join(out, "tmp", "vitest-fs-cache"),
};
// Owner modules capture environment on import. Setup has no observer and is unmeasured.
Object.assign(process.env, env);
const { createSqliteSnapshotStagingTokenSync } = await import(
  pathToFileURL(path.join(repo, "src/infra/sqlite-snapshot-staging.ts")).href
);
const payload = "Synthetic snapshot payload. No user state.\n";
const snapshots = [];
for (let i = 0; i < 4; i++) {
  const owned = createSqliteSnapshotStagingTokenSync(path.join(out, "young-fixture"));
  try {
    fs.writeFileSync(path.join(owned.directory, "first"), payload, { flag: "wx", mode: 0o600 });
    snapshots.push(owned.directory);
  } finally {
    // Released native owner makes these abandoned but ineligible under the 15-minute grace period.
    owned.release();
  }
}

const shape = (sql) =>
  sql
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\s+/g, " ")
    .trim();
async function run(label, fixture) {
  const ledger = path.join(out, `${label}-ledger`);
  fs.mkdirSync(ledger, { mode: 0o700 });
  fs.writeFileSync(path.join(ledger, "phase"), label);
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(repo, "scripts/tsx.mjs"),
      path.join(repo, "src/infra/sqlite-readonly-location.worker.ts"),
      "--openclaw-sqlite-readonly-child",
      "reclaim",
      fixture,
    ],
    {
      cwd: repo,
      env: {
        ...env,
        NODE_OPTIONS: `--require=${path.join(harness, "observer.cjs")}`,
        SQLMEASURE_OUT: ledger,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value) => {
    stdout += value;
  });
  child.stderr.setEncoding("utf8").on("data", (value) => {
    stderr += value;
  });
  // Reclaim stops on stdin EOF; retain the pipe until the child finishes its bounded pass.
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  fs.writeFileSync(path.join(out, `${label}-stderr.log`), stderr);
  if (exit.code !== 0) {
    throw new Error(`${label} child failed; inspect its synthetic stderr log`);
  }
  const result = JSON.parse(stdout);
  if (!result.ok || !Array.isArray(result.warnings)) {
    throw new Error(`${label} returned an invalid result`);
  }
  const processes = [],
    counts = {},
    failures = [];
  let statements = 0,
    requests = 0;
  for (const name of fs.readdirSync(ledger).filter((entry) => /^sql-\d+-\d+\.jsonl$/.test(entry))) {
    const sites = new Map();
    for (const line of fs.readFileSync(path.join(ledger, name), "utf8").trim().split("\n")) {
      const row = JSON.parse(line);
      if (Array.isArray(row)) {
        const site = sites.get(row[1]);
        if (site.method === "prepare") {
          continue;
        }
        if (!site.ok) {
          failures.push({ method: site.method, shape: shape(site.sql) });
          continue;
        }
        statements++;
        const key = shape(site.sql);
        counts[key] = (counts[key] ?? 0) + 1;
      } else if (row.type === "site") {
        sites.set(row.id, row);
      } else if (row.type === "process") {
        processes.push({
          pid: row.pid,
          ppid: row.ppid,
          threadId: row.threadId,
          observerIsMainThread: row.isMainThread,
          role: "sqlite-reclamation-child",
        });
      } else if (row.type === "request") {
        requests++;
      }
    }
  }
  return {
    label,
    controllerPid: process.pid,
    childPid: child.pid,
    exit,
    statements,
    observerWorkerRequests: requests,
    childLaunches: 1,
    gatewayMainStatements: 0,
    processes,
    counts,
    failedExecutions: failures,
    warnings: result.warnings,
  };
}
const young = await run("young", path.join(out, "young-fixture"));
const empty = await run("empty", path.join(out, "empty-fixture"));
const preserved = snapshots.every(
  (directory) =>
    fs.readFileSync(path.join(directory, "first"), "utf8") === payload &&
    fs.existsSync(path.join(directory, "owner.sqlite")),
);
if (!preserved) {
  throw new Error("Young snapshot preservation failed");
}
const summary = {
  sourceHead: head.stdout.trim(),
  node: process.version,
  frozenHarnessFilesVerified: Object.keys(hashes).length,
  setup: {
    snapshots: 4,
    layout: "current generation, flat first payload",
    nativeCreatorReleased: true,
  },
  scope: "Source-level one-shot child reproduction; not a Gateway E2E or timing measurement",
  young,
  empty,
  youngSnapshotsPreserved: preserved,
};
fs.writeFileSync(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
