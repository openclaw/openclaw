#!/usr/bin/env node
// Synthetic legacy backlog; setup is excluded from collector measurements.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const defaultOwner = fileURLToPath(new URL("./pr-lib/cache-lifetime.mjs", import.meta.url));
const cachePath = (root) => join(root, ".cache/openclaw/pr-dependencies/v3");
const key = (kind, index) => createHash("sha256").update(`${kind}-${index}`).digest("hex");
const old = new Date(Date.now() - 25 * 60 * 60 * 1000);

function payload(directory, count, bytes) {
  const block = Buffer.alloc(bytes, 0x61);
  for (let index = 0; index < count; index++) {
    const path = join(directory, `package-${index}.fixture`);
    writeFileSync(path, block);
    utimesSync(path, old, old);
  }
  utimesSync(directory, old, old);
}

async function produce(args) {
  const [ownerPath, mode, entryKey, files, bytes, anchorPath, creatorPid] = args;
  const owner = await import(pathToFileURL(ownerPath).href);
  const anchor = owner.claimCreatedAnchor(anchorPath, Number(creatorPid));
  const cache = cachePath(process.env.HOME);
  const entry = join(cache, entryKey);
  if (mode === "hold") {
    owner.withDependencyCacheLock(cache, (lock) => owner.holdDependencyCache(lock, entry, anchor));
  } else {
    const stage = join(cache, `install-${process.pid}-${randomUUID().replaceAll("-", "")}`);
    mkdirSync(stage, { mode: 0o700 });
    payload(stage, Number(files), Number(bytes));
    // This deliberately uses the pre-lease producer contract: the measured
    // backlog predates operation leases and stage-intent bookkeeping.
    owner.withDependencyCacheLock(cache, (lock) =>
      owner.publishDependencyCache(lock, stage, entry, anchor),
    );
  }
  if (mode === "settle") {
    owner.retireAnchorDependencies(anchor, () => rmSync(anchor.path, { recursive: true }));
  } else {
    utimesSync(anchor.path, old, old);
  }
}

function census(root) {
  const cache = cachePath(root);
  const names = readdirSync(cache).sort();
  const db = new DatabaseSync(join(cache, "lifetime.sqlite"), { readOnly: true });
  try {
    const count = (sql) => Number(db.prepare(sql).get().count);
    const transitions = db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'dependency_transitions'")
      .get();
    return {
      entries: names.filter((name) => /^[a-f0-9]{64}$/.test(name)).length,
      installations: count("SELECT count(*) AS count FROM installations"),
      unsettled: count("SELECT count(*) AS count FROM installations WHERE settled = 0"),
      holds: count("SELECT count(*) AS count FROM holds"),
      anchors: readdirSync(root).filter((name) => name.startsWith("openclaw-pr-anchor-v3.")).length,
      transitions: transitions ? count("SELECT count(*) AS count FROM dependency_transitions") : 0,
      namespace: names,
    };
  } finally {
    db.close();
  }
}

function storage(root) {
  let files = 0,
    logicalBytes = 0,
    allocatedBytes = 0;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop();
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name));
    } else if (stat.isFile()) {
      files++;
      logicalBytes += stat.size;
      allocatedBytes += stat.blocks * 512;
    }
  }
  return { files, logicalBytes, allocatedBytes };
}

async function setup(root, ownerPath, files, bytes) {
  mkdirSync(root, { mode: 0o700 });
  root = realpathSync(root);
  const owner = await import(pathToFileURL(ownerPath).href);
  const cache = cachePath(root);
  owner.withDependencyCacheLock(cache, () => {});
  const count = (index) => Math.floor(files / 46) + (index < files % 46 ? 1 : 0);
  const worker = (mode, index, fileCount) => {
    // Each anchor has an actual creator PID, now exited. Bash owns FD9 and exec
    // preserves that PID while the production owner publishes the ledger rows.
    const shell =
      'anchor="$1/openclaw-pr-anchor-v3.$$.fixture"; mkdir -m 700 "$anchor" || exit; exec 9<"$anchor"; shift; exec "$@" "$anchor" "$$"';
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        shell,
        "pr-cache-fixture",
        root,
        process.execPath,
        self,
        "--produce",
        ownerPath,
        mode,
        key("installation", index),
        String(fileCount),
        String(bytes),
      ],
      { env: { ...process.env, HOME: root, OPENCLAW_PR_LIFETIME_FILE: "" }, encoding: "utf8" },
    );
    if (result.error || result.status !== 0)
      throw new Error(result.stderr || String(result.error || result.status));
  };
  for (let index = 0; index < 20; index++)
    worker(index < 15 ? "publish" : "settle", index, count(index));
  for (let index = 0; index < 13; index++) worker("hold", index, 0);
  for (let index = 20; index < 46; index++) {
    const path = join(cache, key("seeded-legacy-orphan", index));
    mkdirSync(path, { mode: 0o700 });
    payload(path, count(index), bytes);
  }
  return {
    phase: "setup",
    root,
    owner: ownerPath,
    payloadFiles: files,
    payloadBytes: files * bytes,
    orphanOrigin: "26 explicitly seeded physical legacy scratch entries",
    state: census(root),
    storage: storage(root),
  };
}

async function run(root, ownerPath) {
  root = realpathSync(root);
  const owner = await import(pathToFileURL(ownerPath).href);
  const cache = cachePath(root);
  const before = census(root);
  const beforeStorage = storage(root);
  const samples = [];
  let previous = before;
  for (let sweep = 0; sweep < 128; sweep++) {
    const heapBefore = process.memoryUsage().heapUsed;
    const cpu = process.cpuUsage();
    const started = performance.now();
    const retired = owner.withDependencyCacheLock(cache, (lock) =>
      owner.collectUnusedDependencyCaches(lock),
    );
    for (const path of retired) rmSync(path, { recursive: true });
    const wallMs = performance.now() - started;
    const consumed = process.cpuUsage(cpu);
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    const current = census(root);
    samples.push({
      wallMs,
      nodeCpuMs: (consumed.user + consumed.system) / 1000,
      heapDeltaBytes,
      entries: current.entries,
      holds: current.holds,
      anchors: current.anchors,
    });
    if (JSON.stringify(previous) === JSON.stringify(current)) {
      return {
        phase: "run",
        root,
        owner: ownerPath,
        before,
        after: current,
        storageBefore: beforeStorage,
        storageAfter: storage(root),
        sweeps: samples,
        wallMs: samples.reduce((sum, sample) => sum + sample.wallMs, 0),
        nodeCpuMs: samples.reduce((sum, sample) => sum + sample.nodeCpuMs, 0),
        nodeMaxRssKiB: process.resourceUsage().maxRSS,
        metricScope:
          "Collector plus returned-directory deletion; census/setup excluded. CPU and heap cover Node only, not Python children. Heap delta is retained heap change, not total allocation. Use external time for process-tree CPU.",
      };
    }
    previous = current;
  }
  throw new Error("Synthetic cache did not converge within 128 sweeps");
}

async function main(args) {
  if (args[0] === "--produce") return produce(args.slice(1));
  if (args[0] === "--help" || !args.length) {
    console.log(
      "Usage: node scripts/bench-pr-dependency-cache.mjs --setup <new-root> [--owner <module.mjs>] [--files 62000] [--bytes 19050]\n       /usr/bin/time -p node scripts/bench-pr-dependency-cache.mjs --run <root> [--owner <module.mjs>]\nSetup creates real payload bytes and legacy ledger rows through production APIs. Run each sample on a fresh setup; copied SQLite ledgers retain different inode identities. No Team data or agent database is needed by this owner.",
    );
    return;
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (
      !args[index + 1] ||
      !["--setup", "--run", "--owner", "--files", "--bytes"].includes(args[index])
    )
      throw new Error("Invalid benchmark arguments; use --help");
    options.set(args[index], args[index + 1]);
  }
  if (options.has("--setup") === options.has("--run"))
    throw new Error("Select exactly one of --setup or --run");
  const root = resolve(options.get("--setup") || options.get("--run"));
  const ownerPath = resolve(options.get("--owner") || defaultOwner);
  const files = Number(options.get("--files") || 62000),
    bytes = Number(options.get("--bytes") || 19050);
  if (![files, bytes].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error("Invalid fixture size");
  if (options.has("--setup") && existsSync(root))
    throw new Error("Setup requires a new empty path");
  const result = options.has("--setup")
    ? await setup(root, ownerPath, files, bytes)
    : await run(root, ownerPath);
  console.log(JSON.stringify(result));
}

await main(process.argv.slice(2));
