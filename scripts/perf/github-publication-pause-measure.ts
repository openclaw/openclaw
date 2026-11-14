/**
 * Measure real prepare_pr Git acquisition and reconciliation with synthetic GitHub I/O.
 *
 * node scripts/perf/github-publication-pause-measure.ts --seed <new-directory>
 * node scripts/perf/github-publication-pause-measure.ts --freeze-source <new-directory> --revision <base>
 * node scripts/perf/github-publication-pause-measure.ts --freeze-source <new-directory>
 * node scripts/perf/github-publication-pause-measure.ts --source-root <frozen-directory>
 *   --fixture <seed-directory> --output <new-result-directory>
 * Add --native-image <installed-image-id> for a real Docker guest and heartbeat;
 * use --temporary-root <short-existing-directory> to place fixtures off the OS disk.
 *
 * Run two baseline controls, then five interleaved A/B pairs. Allocation profiling
 * is a separate pass (--allocation), never mixed with unprofiled timing samples.
 * The unchanged tree has 62k files/1.1 GB. Its upstream adds 512 MiB of unique
 * historical objects then replaces them with small current files. This local Git
 * server declines filtering, so the real fetch downloads history while the final
 * working-tree delta remains below existing reconciliation limits. Empty 62k-file
 * imports exceed the 50k changed-path limit; 512 MiB incompressible current deltas
 * exceed the 256 MiB result-pack limit. Neither limit is changed by this fixture.
 *
 * Without --native-image container I/O is the simulated engine boundary: frozen
 * intervals are owner pause requests. Native Docker mounts the same projection,
 * executes guest shell calls, and measures heartbeat gaps. Neither qualifies btrfs.
 * Git, agent action, authority, workspace storage, and reconciliation are real.
 * Uses synthetic state with no model or external GitHub calls.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    seed: { type: "string" },
    "freeze-source": { type: "string" },
    "refresh-harness": { type: "string" },
    revision: { type: "string" },
    "source-overlay": { type: "string", multiple: true },
    "source-root": { type: "string" },
    fixture: { type: "string" },
    output: { type: "string" },
    "temporary-root": { type: "string" },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "17742" },
    "history-mib": { type: "string", default: "512" },
    allocation: { type: "boolean", default: false },
    "native-image": { type: "string" },
  },
});
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const testPath = "src/gateway/github-pr-workspace-preparation.test.ts";
const supportPath = "src/gateway/github-pr-workspace-preparation.test-support.ts";
const gitSupportPath = "src/gateway/github-publication-git.test-support.ts";
const scriptPath = "scripts/perf/github-publication-pause-measure.ts";
const files = Number(values.files);
const fileBytes = Number(values["file-bytes"]);
const historyMiB = Number(values["history-mib"]);
for (const value of [files, fileBytes, historyMiB]) {
  assert(Number.isSafeInteger(value) && value > 0);
}

if (values.seed) {
  const seed = path.resolve(values.seed);
  fs.mkdirSync(seed);
  const payload = path.join(seed, "payload");
  const history = path.join(seed, "history");
  fs.mkdirSync(payload);
  fs.mkdirSync(history);
  for (let index = 0; index < files; index++) {
    const directory = path.join(payload, String(Math.floor(index / 100)).padStart(4, "0"));
    if (index % 100 === 0) {
      fs.mkdirSync(directory);
    }
    const bytes = Buffer.alloc(fileBytes, 120);
    bytes.write(String(index));
    fs.writeFileSync(path.join(directory, String(index).padStart(6, "0") + ".txt"), bytes);
  }
  const hashes: Record<string, string> = {};
  // Preserve identical random bytes across every arm; only this seed is random.
  for (let index = 0, remaining = historyMiB; remaining > 0; index++) {
    const bytes = randomFillSync(Buffer.alloc(Math.min(32, remaining) * 1024 ** 2));
    const name = "history-" + index + ".bin";
    fs.writeFileSync(path.join(history, name), bytes);
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
    remaining -= bytes.length / 1024 ** 2;
  }
  fs.writeFileSync(
    path.join(seed, "seed.json"),
    JSON.stringify({ files, fileBytes, historyMiB, hashes }, null, 2),
  );
  console.log(seed);
  process.exit(0);
}

const fixtureTest = String.raw`
// Install the registered-action fixture before loading its owners.
// oxfmt-ignore
import { fixture, bindFixtureRuntime, mocks } from "./github-pr-workspace-preparation.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { Session } from "node:inspector/promises";
import { it, expect, onTestFinished } from "vitest";
import * as engine from "../agents/sandbox/docker.js";
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";

installGitHubPublicationTestHarness({ creatorEmail: "publication-guest@example.test", sandbox: "required", realWorktree: true });

it("measures immutable object acquisition beside a live guest", async () => {
  const output = process.env.OPENCLAW_PUBLICATION_PAUSE_OUTPUT!;
  const fixtureRoot = process.env.OPENCLAW_PUBLICATION_PAUSE_FIXTURE!;
  const seed = JSON.parse(await fs.readFile(path.join(fixtureRoot, "seed.json"), "utf8"));
  console.log("publication-pause: preparing workspace");
  const f = await fixture({ fork: true });
  console.log("publication-pause: workspace ready");
  const nativeImage = process.env.OPENCLAW_PUBLICATION_PAUSE_NATIVE_IMAGE;
  const nativeName = process.env.OPENCLAW_PUBLICATION_PAUSE_NATIVE_NAME!;
  const docker = (args: string[], input?: string | Buffer, allowFailure = false) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 }, (error, stdout, stderr) => {
        if (error && !allowFailure) {
          reject(error);
        } else {
          resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr });
        }
      });
      child.stdin?.end(input);
    });
  if (nativeImage) {
    await docker(["run", "--detach", "--name", nativeName, "--network=none", "--cap-drop=ALL", "--memory=256m", "--cpus=1", "--env", "GIT_AUTHOR_NAME=Fixture", "--env", "GIT_COMMITTER_NAME=Fixture", "--env", "GIT_AUTHOR_EMAIL=fixture@example.test", "--env", "GIT_COMMITTER_EMAIL=fixture@example.test", "--mount", "type=bind,src=" + f.projection + ",dst=" + f.projection, "--workdir", f.projection, nativeImage, "node", "-e", "const fs=require('fs');setInterval(()=>fs.appendFileSync('.git/pause-proof-heartbeat.jsonl',String(Date.now())+'\\n'),25)"]);
    onTestFinished(async () => { await docker(["rm", "--force", nativeName]); });
    f.sandbox.backend!.runShellCommand = async ({ script, args, stdin }) => {
      const result = await docker(["exec", "--interactive", "--workdir", f.projection, nativeName, "sh", "-c", script, "sandbox-fixture", ...(args ?? [])], stdin, true);
      return { code: result.code, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) };
    };
  }
  const runtime = await bindFixtureRuntime(f);
  using _projection = runtime.projection;
  const upstream = (...args: string[]) => f.local!.git("-C", f.upstream, ...args);
  await upstream("config", "gc.auto", "0");
  await upstream("config", "uploadpack.allowFilter", "false");
  await upstream("checkout", "topic/existing");
  await fs.cp(path.join(fixtureRoot, "history"), path.join(f.upstream, "history"), { recursive: true });
  await upstream("add", "history");
  await upstream("-c", "pack.window=0", "commit", "-m", "Synthetic historical object population");
  for (const name of Object.keys(seed.hashes)) {
    await fs.writeFile(path.join(f.upstream, "history", name), "current synthetic contents\n");
  }
  await upstream("add", "history");
  await upstream("commit", "-m", "Keep small current files");
  const head = await f.advanceHead({ "pr.txt": "current PR contents\n" });
  console.log("publication-pause: upstream history ready");
  const fetched: { durationMs: number; pausedAtStart: boolean; pausedAtEnd: boolean }[] = [];
  const pauses: { start: number; end?: number }[] = [];
  let currentPause: { start: number; end?: number } | undefined;
  const engineCall = engine.execContainer.getMockImplementation()!;
  engine.execContainer.mockImplementation(async (selected, args, options) => {
    if (args[0] === "pause") {
      currentPause = { start: performance.now() };
      pauses.push(currentPause);
    }
    const simulated = await engineCall(selected, args, options);
    const result = nativeImage ? await docker(args) : simulated;
    if (args[0] === "unpause" && currentPause) {
      currentPause.end = performance.now();
      currentPause = undefined;
    }
    return result;
  });
  const bytesUnder = async (root: string): Promise<number> => {
    let result = 0;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      result += entry.isDirectory() ? await bytesUnder(file) : (await fs.stat(file)).size;
    }
    return result;
  };
  const objects = path.resolve(f.cwd, await f.git("rev-parse", "--git-common-dir"), "objects");
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv: string[], options) => {
    if (!argv.includes("fetch")) {
      return await transport(argv, options);
    }
    const started = performance.now();
    const pausedAtStart = runtime.isPaused();
    const result = await transport(argv, options);
    fetched.push({ durationMs: performance.now() - started, pausedAtStart, pausedAtEnd: runtime.isPaused() });
    return result;
  });
  const allocation = process.env.OPENCLAW_PUBLICATION_PAUSE_ALLOCATION === "1";
  const guestCpu = async () => nativeImage
    ? Number((await docker(["exec", nativeName, "cat", "/sys/fs/cgroup/cpu.stat"])).stdout.match(/^usage_usec (\d+)$/m)?.[1])
    : null;
  const objectBytesBefore = await bytesUnder(objects);
  const guestCpuBefore = await guestCpu();
  const heartbeatStart = nativeImage ? (await fs.readFile(path.join(f.projection, ".git/pause-proof-heartbeat.jsonl"), "utf8")).trim().split("\n").length : 0;
  const inspector = new Session();
  if (allocation) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
    await inspector.post("HeapProfiler.enable");
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  }
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const heapBefore = process.memoryUsage();
  const started = performance.now();
  const beforeLoad = os.loadavg();
  console.log("publication-pause: measured owner starts");
  let outcome: unknown;
  let failure: string | undefined;
  try {
    outcome = await f.invoke();
  } catch (error) {
    failure = String(error);
  }
  const ownerMs = performance.now() - started;
  const processCpu = process.cpuUsage(cpu);
  const mainCpu = process.threadCpuUsage(threadCpu);
  const heapAfter = process.memoryUsage();
  let sampledAllocationBytes: number | null = null;
  if (allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: typeof profile.head): number => node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledAllocationBytes = sum(profile.head);
    await fs.writeFile(path.join(output, "heap-profile.json"), JSON.stringify(profile));
    const cpuProfile = await inspector.post("Profiler.stop");
    await fs.writeFile(path.join(output, "owner.cpuprofile"), JSON.stringify(cpuProfile.profile));
    inspector.disconnect();
  }
  const guestCpuAfter = await guestCpu();
  const objectBytesAfter = await bytesUnder(objects);
  const pauseMs = pauses.map(({ start, end }) => (end ?? performance.now()) - start);
  if (nativeImage) {
    await docker(["exec", nativeName, "node", "-e", "require('fs').appendFileSync('.git/pause-proof-heartbeat.jsonl',String(Date.now())+'\\n')"]);
  }
  const heartbeats = nativeImage
    ? (await fs.readFile(path.join(f.projection, ".git/pause-proof-heartbeat.jsonl"), "utf8")).trim().split("\n").slice(Math.max(0, heartbeatStart - 1)).map(Number)
    : [];
  const report = {
    fixture: seed,
    qualification: nativeImage
      ? "Registered action with synthetic GitHub; native Docker guest, Git fetch and workspace owners on macOS bind mount; no btrfs or production database claim"
      : "Registered action with synthetic GitHub and simulated container engine; real Git fetch and workspace owners; local filesystem, no native guest or btrfs claim",
    nativeImage: nativeImage ?? null,
    heartbeatMaxGapMs: heartbeats.length ? heartbeats.reduce((longest, stamp, index) => Math.max(longest, index ? stamp - heartbeats[index - 1]! : 0), 0) : null,
    node: process.version, bun: process.versions.bun ?? null, executable: process.execPath, platform: process.platform, cpus: os.cpus().length, memory: os.totalmem(), beforeLoad, afterLoad: os.loadavg(),
    ownerMs, processCpuMs: (processCpu.user + processCpu.system) / 1000, mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
    guestCpuMs: guestCpuBefore !== null && guestCpuAfter !== null ? (guestCpuAfter - guestCpuBefore) / 1000 : null,
    heapBefore, heapAfter, sampledAllocationBytes, fetched, pauseMs,
    objectBytesBefore, objectBytesAfter, objectByteGrowth: objectBytesAfter - objectBytesBefore,
    totalPauseMs: pauseMs.reduce((sum, value) => sum + value, 0), maxPauseMs: Math.max(0, ...pauseMs),
    pausedAtReturn: runtime.isPaused(), outcome, failure, verified: false,
  };
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  expect(failure).toBeUndefined();
  expect(outcome).toMatchObject({ status: "prepared", headCommit: head });
  expect(runtime.isPaused()).toBe(false);
  expect(await f.git("write-tree")).toBe(await upstream("rev-parse", head + "^{tree}"));
  for (const root of [f.cwd, f.projection]) {
    for (let index = 0; index < seed.files; index++) {
      const bytes = await fs.readFile(path.join(root, "payload", String(Math.floor(index / 100)).padStart(4, "0"), String(index).padStart(6, "0") + ".txt"));
      const expected = Buffer.alloc(seed.fileBytes, 120);
      expected.write(String(index));
      expect(bytes.equals(expected)).toBe(true);
    }
    for (const name of Object.keys(seed.hashes)) {
      expect(await fs.readFile(path.join(root, "history", name), "utf8")).toBe("current synthetic contents\n");
    }
    expect(await fs.readFile(path.join(root, "pr.txt"), "utf8")).toBe("current PR contents\n");
  }
  report.verified = true;
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}, 1_800_000);
`;

if (values["freeze-source"] || values["refresh-harness"]) {
  const destination = path.resolve(values["freeze-source"] ?? values["refresh-harness"]!);
  if (values["freeze-source"]) {
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/perf/local-workspace-checkpoint-measure.ts",
        "--freeze-source",
        destination,
        ...(values.revision ? ["--revision", values.revision] : []),
      ],
      { cwd: sourceRoot, stdio: "inherit" },
    );
  }
  assert(
    destination !== sourceRoot && fs.existsSync(path.join(destination, "checkpoint-source.json")),
    "Harness installation requires an owned frozen source capsule",
  );
  for (const relative of values["source-overlay"] ?? []) {
    assert(!path.isAbsolute(relative) && !relative.split(path.sep).includes(".."));
    fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), path.join(destination, relative));
  }
  const support = path.join(destination, supportPath);
  const before = fs.readFileSync(path.join(sourceRoot, supportPath), "utf8");
  const needle = '  const upstream = path.join(path.dirname(local.cwd), "upstream");';
  assert.equal(before.split(needle).length, 2);
  fs.writeFileSync(
    support,
    before.replace(
      needle,
      [
        '  await fs.cp(path.join(process.env.OPENCLAW_PUBLICATION_PAUSE_FIXTURE!, "payload"), path.join(local.cwd, "payload"), { recursive: true });',
        '  await local.git("config", "gc.auto", "0");',
        '  await local.git("add", "-A");',
        '  await local.git("commit", "--quiet", "-m", "Synthetic large project baseline");',
        '  await local.git("update-ref", "refs/heads/main", "HEAD");',
        needle,
      ].join("\n"),
    ),
  );
  // Measurement only: large local fetches can exceed the small fixture transport deadline.
  fs.writeFileSync(
    support,
    fs.readFileSync(support, "utf8").replaceAll("timeoutMs: 10_000,", "timeoutMs: 180_000,"),
  );
  fs.writeFileSync(
    support,
    fs
      .readFileSync(support, "utf8")
      .replace(
        'containerName: "existing-pr-recovery",',
        'containerName: process.env.OPENCLAW_PUBLICATION_PAUSE_NATIVE_NAME ?? "existing-pr-recovery",',
      ),
  );
  fs.writeFileSync(
    path.join(destination, gitSupportPath),
    fs
      .readFileSync(path.join(sourceRoot, gitSupportPath), "utf8")
      .replace("timeoutMs: 10000,", "timeoutMs: 180000,")
      .replace("input?: string };", "input?: string; maxOutputBytes?: number };")
      .replace("maxOutputBytes: 256 * 1024,", "maxOutputBytes: options?.maxOutputBytes,"),
  );
  fs.writeFileSync(path.join(destination, testPath), fixtureTest);
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(destination, scriptPath));
  const overlays = [
    supportPath,
    gitSupportPath,
    testPath,
    scriptPath,
    ...(values["source-overlay"] ?? []),
  ];
  const manifest = {
    source: JSON.parse(fs.readFileSync(path.join(destination, "checkpoint-source.json"), "utf8")),
    harnessSha256: createHash("sha256")
      .update(fs.readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    testSha256: createHash("sha256").update(fixtureTest).digest("hex"),
    ownerSha256: createHash("sha256")
      .update(
        fs.readFileSync(path.join(destination, "src/gateway/github-publication-base-refresh.ts")),
      )
      .digest("hex"),
    overlays: Object.fromEntries(
      overlays.map((relative) => [
        relative,
        createHash("sha256")
          .update(fs.readFileSync(path.join(destination, relative)))
          .digest("hex"),
      ]),
    ),
  };
  fs.writeFileSync(
    path.join(destination, "publication-pause-source.json"),
    JSON.stringify(manifest, null, 2),
  );
  process.exit(0);
}

assert(
  values["source-root"] && values.fixture && values.output,
  "Select --seed, --freeze-source, or --source-root/--fixture/--output",
);
const frozen = path.resolve(values["source-root"]);
assert(fs.existsSync(path.join(frozen, "publication-pause-source.json")));
const output = path.resolve(values.output);
fs.mkdirSync(output);
const temporaryRoot = values["temporary-root"]
  ? path.resolve(values["temporary-root"])
  : path.join(output, "tmp");
fs.mkdirSync(temporaryRoot, { recursive: true });
fs.copyFileSync(
  path.join(frozen, "publication-pause-source.json"),
  path.join(output, "source.json"),
);
const log = fs.openSync(path.join(output, "run.log"), "w");
try {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-vitest.mjs", testPath, "--maxWorkers=1", "--testTimeout=1800000"],
    {
      cwd: frozen,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        TMPDIR: temporaryRoot,
        OPENCLAW_PUBLICATION_PAUSE_FIXTURE: path.resolve(values.fixture),
        OPENCLAW_PUBLICATION_PAUSE_OUTPUT: output,
        OPENCLAW_PUBLICATION_PAUSE_ALLOCATION: values.allocation ? "1" : "0",
        OPENCLAW_PUBLICATION_PAUSE_NATIVE_IMAGE: values["native-image"],
        OPENCLAW_PUBLICATION_PAUSE_NATIVE_NAME: "openclaw-pause-proof-" + process.pid,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(output, "vitest-fs-cache"),
      },
    },
  );
  console.log(JSON.stringify({ output, exitCode: result.status, error: result.error?.message }));
  process.exitCode = result.status ?? 1;
} finally {
  fs.closeSync(log);
}
