// Run on one isolated Linux Testbox; cache snapshots share one fixed live path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runManagedCommand } from "../lib/managed-child-process.mts";

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert.ok(values.output, "--output is required");
assert.equal(process.platform, "linux", "This workload requires Linux");
assert.equal(process.versions.node, "24.22.1", "Use the CI Node pin");
assert.ok(!existsSync(values.output), "Result already exists");
const file = "src/gateway/server.models-auth-order.test.ts";
const config = "test/vitest/vitest.gateway-server.config.ts";
const source = readFileSync(file);
assert.equal(
  createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex"),
  "fb2bd7b01e200d1605f7cd3b701b0fb4b0727d68",
  "Workload changed",
);
const scratch = mkdtempSync(path.join(tmpdir(), "gateway-transform-proof-"));
const live = path.join(scratch, "live");
const baseline = path.join(scratch, "baseline");
const candidate = path.join(scratch, "candidate");
const log = path.join(scratch, "command.log");
const usage = path.join(scratch, "usage.txt");
const report = path.join(scratch, "report.json");
const signal = AbortSignal.timeout(45 * 60_000);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CI: "true",
  NODE_OPTIONS: "--max-old-space-size=8192",
  OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all",
  OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
  OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: path.join(live, "transforms"),
  NODE_COMPILE_CACHE: path.join(live, "compile"),
  OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: "1",
  OPENCLAW_NODE_COMPILE_CACHE_WRITER: "1",
};
for (const key of [
  "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH",
  "OPENCLAW_VITEST_INCLUDE_FILE",
  "OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE",
  "OPENCLAW_NODE_TEST_TARGETS_JSON",
  "OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64",
  "OPENCLAW_NODE_TEST_ENV_JSON",
  "OPENCLAW_NODE_TEST_GROUPS_JSON",
  "OPENCLAW_NODE_TEST_VITEST_ARGS_JSON",
]) {
  delete env[key];
}
const group = {
  configs: [config],
  includePatterns: [file],
  env: { OPENCLAW_VITEST_MAX_WORKERS: "1" },
  shard_name: "cache-proof:gateway-server",
};
function inventory(root: string): Map<string, number> {
  const result = new Map<string, number>();
  const visit = (dir: string) => {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(name);
      } else if (entry.isFile()) {
        result.set(path.relative(root, name), statSync(name).size);
      } else {
        throw new Error("Cache contains a non-regular entry");
      }
    }
  };
  visit(root);
  return result;
}
const bytes = (items: Map<string, number>) => [...items.values()].reduce((a, b) => a + b, 0);
function copy(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
}
type Command = {
  wallSeconds: number;
  userSeconds: number;
  systemSeconds: number;
  maxRssKiB: number;
};
async function run(
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  bin = process.execPath,
): Promise<Command> {
  const fd = openSync(log, "w", 0o600);
  let exit;
  try {
    exit = await runManagedCommand({
      bin: "/usr/bin/time",
      args: ["-f", "%e %U %S %M", "-o", usage, bin, ...args],
      env: { ...env, ...extra },
      stdio: ["ignore", fd, fd],
      signal,
      timeoutMs: 15 * 60_000,
      requireProcessTreeExit: true,
    });
  } finally {
    closeSync(fd);
  }
  assert.equal(exit, 0, `Command failed; last output: ${readFileSync(log, "utf8").slice(-2400)}`);
  assert.ok(statSync(log).size <= 64 * 1024 ** 2, "Command log exceeded budget");
  const [wallSeconds, userSeconds, systemSeconds, maxRssKiB] = readFileSync(usage, "utf8")
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.ok([wallSeconds, userSeconds, systemSeconds, maxRssKiB].every(Number.isFinite));
  return { wallSeconds, userSeconds, systemSeconds, maxRssKiB };
}
const shardArgs = ["--import", "tsx", "scripts/ci-run-node-test-shard.mts"];
const groupEnv = { OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([group]) };
const readLimit = (name: string) => (existsSync(name) ? readFileSync(name, "utf8").trim() : null);
const result: Record<string, unknown> = {
  status: "running",
  sourceInputs: Object.fromEntries(
    [
      "scripts/ci-warm-vitest-caches.mts",
      "scripts/lib/ci-node-test-plan.mts",
      "scripts/lib/vitest-cache-slots.mts",
      "test/vitest/vitest.performance-config.ts",
    ].map((name) => [name, createHash("sha256").update(readFileSync(name)).digest("hex")]),
  ),
  workload: { file, config, testBlob: "fb2bd7b01e200d1605f7cd3b701b0fb4b0727d68" },
  resources: {
    node: process.version,
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
    cpuMax: readLimit("/sys/fs/cgroup/cpu.max"),
    memoryMax: readLimit("/sys/fs/cgroup/memory.max"),
    initialLoad: loadavg(),
  },
  limits:
    "Screening on one Testbox with a freshly produced full seed, not the historical archive. Local compression/restore excludes backend transfer. No production billing or precise tail estimate.",
};
const preparations: unknown[] = [];
const samples: unknown[] = [];
result.preparations = preparations;
result.samples = samples;
let joined = true;
try {
  mkdirSync(live);
  console.log("cache-proof: preparing existing complete seed");
  result.baselineProducer = await run(["--import", "tsx", "scripts/ci-warm-vitest-caches.mts"], {
    CACHE_WARM_PLATFORM: "linux",
  });
  const original = inventory(live);
  result.baselineBytes = bytes(original);
  result.baselineTransformBytes = bytes(inventory(path.join(live, "transforms")));
  assert.ok(bytes(original) * 3 < 12 * 1024 ** 3, "Temporary cache budget exceeded");
  copy(live, baseline);
  for (let index = 0; index < 5; index++) {
    console.log(`cache-proof: preparation ${index + 1}/5`);
    copy(baseline, live);
    const metrics = await run(shardArgs, {
      ...groupEnv,
      OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--testNamePattern=(?!)"]),
    });
    const prepared = inventory(live);
    const evicted = [...original.keys()].filter((name) => !prepared.has(name));
    preparations.push({
      ...metrics,
      bytes: bytes(prepared),
      transformBytes: bytes(inventory(path.join(live, "transforms"))),
      newFiles: [...prepared.keys()].filter((name) => !original.has(name)).length,
      evictedFiles: evicted.length,
      evictedBytes: evicted.reduce((n, name) => n + original.get(name)!, 0),
    });
    assert.equal(evicted.length, 0, "Candidate evicts existing entries; reject this expansion");
    if (index === 0) {
      copy(live, candidate);
    }
  }
  assert.ok(existsSync("/usr/bin/zstd"), "The CI archive encoder is unavailable");
  const archives: Record<string, string> = {};
  const compression: unknown[] = [];
  result.compression = compression;
  for (let pair = 0; pair < 5; pair++) {
    for (const side of pair % 2 ? ["B", "A"] : ["A", "B"]) {
      const archive = path.join(scratch, `${side}.tar.zst`);
      const root = side === "A" ? baseline : candidate;
      const metrics = await run(
        ["--posix", "--zstd", "-cf", archive, "-C", root, "transforms"],
        {},
        "/usr/bin/tar",
      );
      archives[side] = archive;
      compression.push({ pair, side, ...metrics, archiveBytes: statSync(archive).size });
    }
  }
  for (let pair = 0; pair < 5; pair++) {
    for (const side of pair % 2 ? ["B", "A"] : ["A", "B"]) {
      rmSync(live, { recursive: true, force: true });
      mkdirSync(live);
      const restore = await run(["--zstd", "-xf", archives[side]!, "-C", live], {}, "/usr/bin/tar");
      // Hold Node compilation constant so this comparison isolates Vitest seeding.
      copy(path.join(baseline, "compile"), path.join(live, "compile"));
      for (const phase of ["fresh", "warm"]) {
        console.log(`cache-proof: pair ${pair + 1}/5 ${side} ${phase}`);
        rmSync(report, { force: true });
        const metrics = await run(shardArgs, {
          ...groupEnv,
          OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: "0",
          OPENCLAW_NODE_COMPILE_CACHE_WRITER: "0",
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify([
            "--reporter=json",
            `--outputFile.json=${report}`,
          ]),
        });
        const execution = JSON.parse(readFileSync(report, "utf8"));
        assert.equal(execution.numTotalTests, 1, "Test inventory changed");
        assert.equal(execution.numPassedTests, 1, "Original proof did not pass");
        assert.equal(execution.numFailedTests, 0);
        samples.push({
          pair,
          side,
          phase,
          ...metrics,
          ...(phase === "fresh" ? { restore } : {}),
          passed: execution.numPassedTests,
          load: loadavg(),
          memoryEvents: readLimit("/sys/fs/cgroup/memory.events"),
        });
      }
    }
  }
  result.status = "complete";
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : String(error);
  joined = false;
  process.exitCode = 1;
} finally {
  mkdirSync(path.dirname(values.output), { recursive: true });
  writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  // A failed process-tree join may still own these files; the lease owns retirement.
  if (joined) {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`cache-proof: ${String(result.status)}`);
}
