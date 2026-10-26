// Synthetic checkout.diff workload through the production read/worker owners.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import type { GitCheckoutDiffInput } from "../../src/infra/git-read-operations.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const operationChannel = channel("openclaw.git.operation");

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "poll-state-dir": { type: "string", multiple: true },
    seed: { type: "boolean" },
    untracked: { type: "string", default: "100" },
    tracked: { type: "string", default: "0" },
    boundary: { type: "string", default: "worker" },
    cold: { type: "boolean" },
    poll: { type: "boolean" },
    scope: { type: "string", default: "all" },
    summary: { type: "boolean" },
    port: { type: "string", default: "41473" },
    tabs: { type: "string", default: "3" },
    background: { type: "string", default: "8" },
    agents: { type: "string", default: "2" },
    maintenance: { type: "string", default: "2" },
    "duration-ms": { type: "string", default: "30000" },
    "observe-git-queues": { type: "boolean" },
    "read-cache-owner": { type: "string" },
    "heavy-files": { type: "string", default: "16" },
    "heavy-lines": { type: "string", default: "4096" },
    mutate: { type: "boolean" },
    samples: { type: "string", default: "40" },
    "poll-ms": { type: "string", default: "0" },
    "churn-ms": { type: "string", default: "0" },
    "nested-cwd": { type: "boolean" },
    "missing-cwd": { type: "boolean" },
    "nested-repository": { type: "boolean" },
    "excludes-file": { type: "boolean" },
    "start-at": { type: "string" },
    output: { type: "string" },
    revision: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Seed once into a new synthetic directory:
  node --import ./scripts/tsx.mjs scripts/perf/checkout-diff-measure.ts --state-dir <path> --seed
Measure that fixture on the authorized benchmark host:
  ... --state-dir <path> --boundary worker --summary --mutate --samples 40 --output <file>
Use --boundary read for loadCheckoutDiff, omit --summary for full patches, and
omit --mutate for unchanged polls. Set --poll-ms 10050 to cross the old summary
cache TTL. --start-at <epoch-ms> synchronizes concurrent baseline/candidate pairs.
Git trace2 counts real subprocesses; its small write cost is included on both sides.
Use --boundary rpc for real sessions.diff WebSocket requests; add --summary for
summary polls. Combine --tabs 3 with
--background 8 full-diff readers, --maintenance 2 bounded Git readers, and
--agents 2 external Git loops. --heavy-files/--heavy-lines size the seeded load
checkout. The RPC boundary starts an isolated loopback Gateway on --port >=40000.
Use --tracked 267000 at seed time for an unchanged large tracked inventory. Files
are empty and written sequentially; Linux Dirty memory is checked every 1,000 files.
Use --nested-cwd to launch sessions from the existing new/ subdirectory.
Use --missing-cwd to remove that subdirectory after session creation and verify
negative-result reuse, then recreate it and verify recovery after polling.
At seed time, --nested-repository replaces one untracked file with an opaque
agent-created Git checkout. --excludes-file adds an external core.excludesFile
and an ignored file in a >64 KiB branch config; RPC measurement verifies an
ignore-file edit is visible.
Add --poll-state-dir <other seeded fixture> to poll multiple checkouts concurrently
through separate sessions. Extra fixtures are read-only and prohibit --mutate.
Use --observe-git-queues to collect queue timings through benchmark-only loader
instrumentation applied identically to both revisions. No production state or model
is involved. --churn-ms 1000 periodically saves identical tracked content, runs
git status on the polling checkout, and rotates an ignored build file. Unchanged
responses must match warmup. A real post-run edit must reach every tab within
12 seconds; first-poll visibility and eventual visibility timing are recorded.
Use --cold --boundary rpc --tabs 40 --poll-ms 5000 for an unprimed reconnect burst.
Each cold client polls one checkout, retrying computing responses after 500 ms. No diff
warmup runs; the first response and first materialized content are timed separately,
and response contents are verified after measurement. Cold mode prohibits mutation.
Use --scope uncommitted for working-tree-only diffs (default: all). --poll opts RPC
requests into nonblocking poll responses on revisions that support that contract.
Use --read-cache-owner <adjacent baseline.ts> with --boundary rpc to compare a
previous Git read-cache owner against the candidate in one source checkout.`);
  process.exit(0);
}
const integer = (raw: string, label: string, min = 0) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
if (!values["state-dir"]) {
  throw new Error("--state-dir must name a task-owned synthetic fixture");
}
if (values.boundary !== "worker" && values.boundary !== "read" && values.boundary !== "rpc") {
  throw new Error("--boundary must be worker, read, or rpc");
}
assert(
  values.scope === "all" || values.scope === "uncommitted",
  "--scope must be all or uncommitted",
);
const scope = values.scope;
assert(
  !values.poll || (values.cold && values.boundary === "rpc"),
  "--poll requires --cold --boundary rpc",
);
assert(
  !values["poll-state-dir"]?.length || values.boundary === "rpc",
  "--poll-state-dir requires --boundary rpc",
);
const root = path.resolve(values["state-dir"]);
const repo = path.join(root, "repository");
const marker = path.join(root, "checkout-diff-fixture.json");
const trace = path.join(root, "git-trace.jsonl");
const untracked = integer(values.untracked, "--untracked", 4);
assert(!values["nested-repository"] || untracked >= 5, "--nested-repository needs --untracked >=5");
if (untracked > 100) {
  throw new Error("--untracked must not exceed the 100-file diff response cap");
}
const samples = integer(values.samples, "--samples", 1);
const tracked = integer(values.tracked, "--tracked");
assert(tracked <= 500_000, "--tracked must not exceed 500000 files");
const pollMs = integer(values["poll-ms"], "--poll-ms");
assert(!values.cold || pollMs > 0, "--cold requires --poll-ms > 0 (use 5000 for steady stress)");
const churnMs = integer(values["churn-ms"], "--churn-ms");
assert(
  !values["missing-cwd"] ||
    (values.boundary === "rpc" && !values.mutate && !churnMs && !values["poll-state-dir"]?.length),
  "--missing-cwd requires RPC polling without mutation or extra fixtures",
);
assert(!churnMs || values.boundary === "rpc", "--churn-ms requires --boundary rpc");
assert(!churnMs || !values["poll-state-dir"]?.length, "--churn-ms requires one owned checkout");
assert(
  !values.cold || (values.boundary === "rpc" && !values.mutate && !values["missing-cwd"]),
  "--cold requires --boundary rpc without --mutate or --missing-cwd",
);
const readCacheOwner = values["read-cache-owner"]
  ? path.resolve(values["read-cache-owner"])
  : undefined;
let readCacheOwnerLoads = 0;
if (readCacheOwner) {
  assert(values.boundary === "rpc" && !values.seed, "--read-cache-owner requires RPC measurement");
  const canonical = new URL("../../src/infra/git-read-cache.ts", import.meta.url);
  assert.equal(
    path.dirname(readCacheOwner),
    path.dirname(fileURLToPath(canonical)),
    "--read-cache-owner must be beside git-read-cache.ts to preserve relative imports",
  );
  const override = pathToFileURL(readCacheOwner).href;
  assert.notEqual(override, canonical.href, "--read-cache-owner must select a different file");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url !== canonical.href) {
        return result;
      }
      readCacheOwnerLoads++;
      return { ...result, url: override };
    },
  });
}
const gitEnv = {
  ...process.env,
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  ...(values["poll-state-dir"]?.length ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
  GIT_AUTHOR_NAME: "Synthetic Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-19T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-19T00:00:00Z",
  GIT_TRACE2_EVENT: undefined,
};
const git = (...args: string[]) =>
  promisify(execFile)("git", ["-C", repo, ...args], { env: gitEnv });

async function seed() {
  await fs.mkdir(root);
  for (const directory of [repo, gitEnv.HOME, gitEnv.TMPDIR]) {
    await fs.mkdir(directory);
  }
  if (tracked) {
    const origin = path.join(root, "worktree-origin");
    const originGit = (...args: string[]) =>
      promisify(execFile)("git", ["-C", origin, ...args], { env: gitEnv });
    await fs.mkdir(origin);
    await originGit("init", "--template=", "--initial-branch=main");
    await originGit(
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "test: seed worktree origin",
    );
    await originGit("worktree", "add", "--detach", repo, "HEAD");
  } else {
    await git("init", "--template=", "--initial-branch=main");
  }
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  for (const file of ["modified.txt", "staged.txt", "deleted.txt", "unchanged.txt"]) {
    await fs.writeFile(path.join(repo, file), "Synthetic tracked content\n");
  }
  for (let index = 0; index < tracked; index++) {
    const bucket = path.join(repo, "inventory", String(Math.floor(index / 1000)));
    if (index % 1000 === 0) {
      if (process.platform === "linux") {
        let dirtyKb: number;
        do {
          dirtyKb = Number(
            /^Dirty:\s+(\d+)/m.exec(await fs.readFile("/proc/meminfo", "utf8"))?.[1],
          );
          assert(dirtyKb < 2 * 1024 * 1024, "Fixture stopped: Linux Dirty memory reached 2 GiB");
          if (dirtyKb >= 1024 * 1024) {
            await delay(1000);
          }
        } while (dirtyKb >= 1024 * 1024);
      }
      await fs.mkdir(bucket, { recursive: true });
    }
    await fs.writeFile(path.join(bucket, `${index}.txt`), "");
  }
  await git("add", ".");
  await git("-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "test: seed synthetic diff");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await fs.writeFile(path.join(repo, "modified.txt"), "Synthetic tracked content\nChanged 0\n");
  await fs.writeFile(path.join(repo, "staged.txt"), "Synthetic staged content\n");
  await git("add", "staged.txt");
  await fs.unlink(path.join(repo, "deleted.txt"));
  await fs.mkdir(path.join(repo, "new"));
  for (let index = 0; index < untracked - 4 - (values["nested-repository"] ? 1 : 0); index++) {
    await fs.writeFile(
      path.join(repo, "new", `text-${String(index).padStart(3, "0")}.txt`),
      `Synthetic untracked file ${index}\n${"Added content\n".repeat(16)}`,
    );
  }
  await fs.writeFile(path.join(repo, "new", "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(repo, "new", "large.txt"), "Large synthetic content\n".repeat(6000));
  await fs.writeFile(path.join(repo, "new", "empty.txt"), "");
  await fs.symlink("../modified.txt", path.join(repo, "new", "link.txt"));
  await fs.mkdir(path.join(repo, "ignored"));
  await fs.writeFile(path.join(repo, "ignored", "hidden.txt"), "Ignored synthetic content\n");
  if (values["nested-repository"]) {
    const nestedRepo = path.join(repo, "agent-clone");
    await fs.mkdir(nestedRepo);
    const nestedGit = (...args: string[]) =>
      promisify(execFile)("git", ["-C", nestedRepo, ...args], { env: gitEnv });
    await nestedGit("init", "--template=", "--initial-branch=main");
    await fs.writeFile(path.join(nestedRepo, "README.md"), "Synthetic nested checkout\n");
    await nestedGit("add", ".");
    await nestedGit(
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "test: seed agent clone",
    );
  }
  if (values["excludes-file"]) {
    await fs.writeFile(path.join(root, "git-excludes"), "external-ignored.txt\n");
    await fs.writeFile(path.join(repo, "external-ignored.txt"), "External ignore control\n");
    await git("config", "core.excludesFile", path.join(root, "git-excludes"));
    const commonGitDir = path.resolve(
      repo,
      (await git("rev-parse", "--git-common-dir")).stdout.trim(),
    );
    await fs.appendFile(
      path.join(commonGitDir, "config"),
      Array.from(
        { length: 1000 },
        (_, index) =>
          `[branch "synthetic-agent-task-${index}"]\n\tremote = origin\n\tmerge = refs/heads/synthetic-agent-task-${index}\n`,
      ).join(""),
    );
  }
  const heavyFiles = integer(values["heavy-files"], "--heavy-files", 1);
  const heavyLines = integer(values["heavy-lines"], "--heavy-lines", 1);
  if (values.boundary === "rpc") {
    const heavyRepo = path.join(root, "heavy-repository");
    await fs.mkdir(heavyRepo);
    const heavyGit = (...args: string[]) =>
      promisify(execFile)("git", ["-C", heavyRepo, ...args], { env: gitEnv });
    await heavyGit("init", "--template=", "--initial-branch=main");
    const content = Array.from(
      { length: heavyLines },
      (_, i) => `Synthetic line ${i} original content\n`,
    ).join("");
    for (let file = 0; file < heavyFiles; file++) {
      await fs.writeFile(path.join(heavyRepo, `tracked-${file}.txt`), content);
    }
    await heavyGit("add", ".");
    await heavyGit("-c", "commit.gpgSign=false", "commit", "-m", "test: seed synthetic load");
    const changed = content.replaceAll("original", "modified");
    for (let file = 0; file < heavyFiles; file++) {
      await fs.writeFile(path.join(heavyRepo, `tracked-${file}.txt`), changed);
    }
  }
  const fixture = {
    ...(values.boundary === "rpc" ? { heavyFiles, heavyLines } : {}),
    format: "openclaw-checkout-diff-v1",
    head,
    untracked,
    tracked: 3,
    unchangedTracked: tracked + 1,
    nestedRepository: values["nested-repository"] === true,
    excludesFile: values["excludes-file"] === true,
  };
  await fs.writeFile(marker, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify(fixture));
}

function summarize(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  return {
    count: numbers.length,
    mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    p50: sorted[Math.ceil(numbers.length * 0.5) - 1],
    p95: sorted[Math.ceil(numbers.length * 0.95) - 1],
    p99: sorted[Math.ceil(numbers.length * 0.99) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
}

async function readFixture(directory: string) {
  const fixture: unknown = JSON.parse(
    await fs.readFile(path.join(directory, "checkout-diff-fixture.json"), "utf8"),
  );
  if (
    !fixture ||
    typeof fixture !== "object" ||
    !("format" in fixture) ||
    fixture.format !== "openclaw-checkout-diff-v1" ||
    !("head" in fixture) ||
    typeof fixture.head !== "string" ||
    !("untracked" in fixture) ||
    typeof fixture.untracked !== "number"
  ) {
    throw new Error("Expected an offline fixture created with --seed");
  }
  return { ...fixture, untracked: fixture.untracked };
}

async function measure() {
  const fixture = await readFixture(root);
  if (values.boundary === "rpc") {
    await measureRpc(fixture);
    return;
  }
  const expectedFiles = fixture.untracked + 3;
  Object.assign(process.env, gitEnv, { GIT_TRACE2_EVENT: trace });
  const [{ loadCheckoutDiff }, { runGitWorkerOperation }, { drainGlobalSingletonLifecycleState }] =
    await Promise.all([
      import("../../src/sessions/session-diff.js"),
      import("../../src/infra/git-worker.js"),
      import("../../src/shared/global-singleton.js"),
    ]);
  const input: GitCheckoutDiffInput = {
    cwd: repo,
    scope,
    summaryOnly: values.summary === true,
  };
  const request = () =>
    values.boundary === "read"
      ? loadCheckoutDiff({ ...input, sessionKey: "synthetic-diff" })
      : runGitWorkerOperation({ type: "checkout.diff", input });
  const sample = async (index: number) => {
    if (values.mutate) {
      await fs.writeFile(
        path.join(repo, "modified.txt"),
        `Synthetic tracked content\nChanged ${index}\n`,
      );
    }
    await fs.writeFile(trace, "");
    const startedAt = Date.now();
    const started = performance.now();
    const result = await request();
    const elapsedMs = performance.now() - started;
    if (result.unavailableReason || result.files.length !== expectedFiles) {
      throw new Error(
        `Missing synthetic changes: ${result.files.length}, ${result.unavailableReason}`,
      );
    }
    const commands: string[] = [];
    for (const line of (await fs.readFile(trace, "utf8")).split("\n").filter(Boolean)) {
      const event: { event?: string; argv?: string[] } = JSON.parse(line);
      if (event.event === "start" && event.argv) {
        const command = event.argv.find((arg) =>
          /^(diff|ls-files|rev-parse|rev-list|log|add|hash-object|symbolic-ref|merge-base|show)$/.test(
            arg,
          ),
        );
        commands.push(
          `${command ?? "other"}${event.argv.includes("--no-index") ? " --no-index" : ""}`,
        );
      }
    }
    const { root: _root, ...portable } = result;
    const response = JSON.stringify(portable);
    return {
      startedAt,
      elapsedMs,
      gitCommands: commands.length,
      commands: Object.fromEntries(
        [...new Set(commands)].map((name) => [
          name,
          commands.filter((value) => value === name).length,
        ]),
      ),
      responseBytes: Buffer.byteLength(response),
      responseSha256: createHash("sha256").update(response).digest("hex"),
    };
  };
  try {
    const warmup = await sample(0);
    console.log(JSON.stringify({ ready: true, warmup }));
    if (values["start-at"]) {
      const startAt = integer(values["start-at"], "--start-at", 1);
      if (Date.now() >= startAt) {
        throw new Error("--start-at passed before worker readiness");
      }
      await delay(startAt - Date.now());
    }
    const results = [];
    for (let index = 1; index <= samples; index++) {
      if (pollMs) {
        await delay(pollMs);
      }
      results.push(await sample(index));
    }
    const report = {
      revision: values.revision ?? null,
      boundary: values.boundary,
      scope,
      summaryOnly: values.summary === true,
      mutate: values.mutate === true,
      pollMs,
      fixture,
      node: process.version,
      latencyMs: summarize(results.map((result) => result.elapsedMs)),
      gitCommands: summarize(results.map((result) => result.gitCommands)),
      warmup,
      samples: results,
    };
    await fs.writeFile(
      path.resolve(values.output ?? path.join(root, "result.json")),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify({ latencyMs: report.latencyMs, gitCommands: report.gitCommands }));
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
}

function observeGitQueues() {
  // Keep measurement instrumentation out of the production API and apply it to both revisions.
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!/\/src\/infra\/git-worker\.(?:ts|js)(?:\?|$)/.test(url)) {
        return result;
      }
      assert(result.source !== undefined, "Git worker source is required for queue observations");
      let source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      for (const [pattern, replacement, expected] of [
        [
          /const measure\s*=\s*timing\s*\|\|\s*options\.diffTiming\b/g,
          "const measure = timing || options.diffTiming || observedAt !== undefined",
          1,
        ],
        [/if\s*\(\s*timing\s*\)/g, "if (measure)", 3],
      ] as const) {
        let guards = 0;
        source = source.replace(pattern, () => {
          guards++;
          return replacement;
        });
        assert.equal(guards, expected, "Expected Git worker measurement guards");
      }
      let publications = 0;
      source = source.replace(/elapsedMs:\s*performance\.now\(\)\s*-\s*observedAt/g, (match) => {
        publications++;
        return `${match}, summaryOnly: command.type === "checkout.diff" && command.input.summaryOnly === true, gitCommandCount, workerQueueWaitMs, summedGitWallMs, summedGitQueueWaitMs`;
      });
      assert.equal(publications, 1, "Expected exactly one Git operation diagnostics publication");
      return { ...result, source };
    },
  });
}

async function measureRpc(fixture: Awaited<ReturnType<typeof readFixture>>) {
  const { BASE_GATEWAY_BENCH_CONFIG } = await import("../lib/gateway-bench-runtime.ts");
  const extraRoots = (values["poll-state-dir"] ?? []).map((directory) => path.resolve(directory));
  assert(!extraRoots.length || !values.mutate, "--poll-state-dir prohibits --mutate");
  const extraFixtures = await Promise.all(extraRoots.map(readFixture));
  const checkoutRoots = [
    repo,
    ...extraRoots.map((directory) => path.join(directory, "repository")),
  ];
  if (values["observe-git-queues"]) {
    observeGitQueues();
  }
  const port = integer(values.port, "--port", 40000);
  assert(port <= 65535);
  const tabs = integer(values.tabs, "--tabs", 1);
  assert(
    !values.cold || tabs >= checkoutRoots.length,
    "--cold needs at least one tab per checkout",
  );
  const background = integer(values.background, "--background");
  const agents = integer(values.agents, "--agents");
  const maintenance = integer(values.maintenance, "--maintenance");
  const durationMs = integer(values["duration-ms"], "--duration-ms", 1000);
  const heavyRepo = path.join(root, "heavy-repository");
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      ...BASE_GATEWAY_BENCH_CONFIG,
      diagnostics: { enabled: true },
      gateway: {
        ...BASE_GATEWAY_BENCH_CONFIG.gateway,
        controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
      },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        entries: { main: { workspace: repo } },
      },
      plugins: { enabled: false },
      cron: { enabled: false },
    }),
  );
  Object.assign(process.env, gitEnv, {
    OPENCLAW_STATE_DIR: path.join(root, "gateway-state"),
    OPENCLAW_CONFIG_PATH: configPath,
    GIT_TRACE2_EVENT: "",
  });
  const [
    { startGatewayServer },
    { GatewayClient },
    { runGitWorkerOperation },
    { withContentGitSlot },
    { runGitBuffered },
    { drainGlobalSingletonLifecycleState },
    { onTrustedInternalDiagnosticEvent, waitForDiagnosticEventsDrained },
  ] = await Promise.all([
    import("../../src/gateway/server.js"),
    import("../../src/gateway/client.js"),
    import("../../src/infra/git-worker.js"),
    import("../../src/infra/git-content-budget.js"),
    import("../../src/agents/worktrees/git.js"),
    import("../../src/shared/global-singleton.js"),
    import("../../src/infra/diagnostic-events.js"),
  ]);
  const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  const peers: InstanceType<typeof GatewayClient>[] = [];
  const operationSamples: Record<string, unknown>[] = [];
  let measured = false;
  let measurementPhase: "cold" | "steady" = values.cold ? "cold" : "steady";
  const phaseSamples: {
    phase: "cold" | "steady";
    name: string;
    durationMs: number;
    details: import("../../src/infra/diagnostic-events.js").DiagnosticPhaseDetails;
  }[] = [];
  const stopPhases = onTrustedInternalDiagnosticEvent(
    (event) => {
      if (
        measured &&
        event.type === "diagnostic.phase.completed" &&
        typeof event.durationMs === "number" &&
        (event.name === "sessions.diff" || event.name === "checkout.diff")
      ) {
        phaseSamples.push({
          phase: measurementPhase,
          name: event.name,
          durationMs: event.durationMs,
          details: event.details ?? {},
        });
      }
    },
    { include: ["diagnostic.phase.completed"] },
  );
  const observe = (event: unknown) => {
    if (measured && event !== null && typeof event === "object") {
      operationSamples.push({ ...event, phase: measurementPhase });
    }
  };
  operationChannel.subscribe(observe);
  try {
    const connections: Promise<void>[] = [];
    for (let tab = 0; tab < tabs; tab++) {
      const ready = Promise.withResolvers<void>();
      const peer = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        clientName: "openclaw-control-ui",
        mode: "webchat",
        platform: "web",
        instanceId: `synthetic-diff-tab-${tab}`,
        scopes: ["operator.admin"],
        requestTimeoutMs: 120_000,
        onHelloOk: () => ready.resolve(),
        onConnectError: (error) => ready.reject(error),
      });
      peers.push(peer);
      peer.start();
      if (values.cold) {
        connections.push(ready.promise);
      } else {
        await ready.promise;
      }
    }
    await Promise.all(connections);
    const targets = checkoutRoots.map((cwd, checkout) => ({
      cwd: values["nested-cwd"] || values["missing-cwd"] ? path.join(cwd, "new") : cwd,
      params: {
        sessionKey: `agent:main:synthetic-diff-contention${checkout ? `-${checkout}` : ""}`,
        scope,
        ...(values.poll ? { poll: true } : {}),
        summaryOnly: values.summary === true,
      },
    }));
    for (const target of targets) {
      await peers[0]!.request("sessions.create", {
        key: target.params.sessionKey,
        cwd: target.cwd,
        visibility: "shared",
      });
    }
    if (values["missing-cwd"]) {
      await fs.rename(path.join(repo, "new"), path.join(repo, "missing-cwd-saved"));
    }
    const warmupStarted = performance.now();
    const responseHash = (
      result: import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult,
    ) => {
      const { root: _root, ...portable } = result;
      return createHash("sha256").update(JSON.stringify(portable)).digest("hex");
    };
    const isComputing = (
      result: import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult,
    ) => result.computing === true;
    const readTargets = () =>
      Promise.all(
        targets.map(async (target) => {
          const deadline = performance.now() + 120_000;
          for (;;) {
            const remainingMs = deadline - performance.now();
            assert(remainingMs > 0, "diff must materialize within 120 seconds");
            const result = await peers[0]!.request<
              import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult
            >("sessions.diff", target.params, { timeoutMs: remainingMs });
            if (!isComputing(result)) {
              return result;
            }
            await delay(Math.min(250, Math.max(0, deadline - performance.now())));
          }
        }),
      );
    const warmupResults = values.cold ? [] : await readTargets();
    const warmupHashes = warmupResults.map(responseHash);
    const verifyContent = (
      result: import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult,
      index: number,
    ) => {
      assert(!isComputing(result), "content verification requires a materialized diff");
      assert.equal(result.unavailableReason, values["missing-cwd"] ? "not_git" : undefined);
      const currentFixture = index === 0 ? fixture : extraFixtures[index - 1]!;
      if ("nestedRepository" in currentFixture && currentFixture.nestedRepository === true) {
        const nested = result.files.find((file) => file.path === "agent-clone/");
        assert(
          nested?.untracked && nested.truncated,
          "nested checkout must remain an opaque entry",
        );
      }
      assert(!result.files.some((file) => file.path === "external-ignored.txt"));
      if (values.cold) {
        assert.equal(result.files.length, currentFixture.untracked + 3);
        assert.equal(
          result.files.find((file) => file.path === "modified.txt")?.additions,
          1,
          "cold polling must eventually return the seeded tracked edit",
        );
        assert(result.files.some((file) => file.path === "new/binary.bin"));
      }
    };
    for (const [index, result] of warmupResults.entries()) {
      verifyContent(result, index);
    }
    const warmupRpcMs = values.cold ? null : performance.now() - warmupStarted;
    if (!values.cold) {
      await Promise.all(
        Array.from({ length: Math.max(1, background) }, () =>
          runGitWorkerOperation({ type: "checkout.diff", input: { cwd: heavyRepo, scope: "all" } }),
        ),
      );
    }
    console.log(
      JSON.stringify({ ready: true, boundary: "rpc", tabs, background, agents, maintenance }),
    );
    if (values["start-at"]) {
      const startAt = integer(values["start-at"], "--start-at", 1);
      assert(startAt > Date.now(), "pair deadline must follow Gateway preparation");
      await delay(startAt - Date.now());
    }
    const rpcSamples: {
      phase: "cold" | "steady";
      sequence: number;
      round?: number;
      tab: number;
      checkout: number;
      elapsedMs: number;
      files: number;
      responseSha256: string;
      computing: boolean;
    }[] = [];
    const refreshSamples: {
      phase: "cold" | "steady";
      tab: number;
      checkout: number;
      startedAtMs: number;
      elapsedMs: number;
    }[] = [];
    const firstPollStarted = new Map<string, number>();
    const firstContentMs = new Map<string, number>();
    let contentReadyAtMs: number | undefined;
    let coldToSteady: Promise<void> | undefined;
    const sampleRpc = async (tab: number, checkout: number, sequence: number) => {
      const pollStarted = performance.now();
      const key = `${tab}:${checkout}`;
      if (values.cold && sequence === 0) {
        firstPollStarted.set(key, pollStarted);
      }
      const result = await peers[tab]!.request<
        import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult
      >("sessions.diff", targets[checkout]!.params);
      const elapsedMs = performance.now() - pollStarted;
      const computing = isComputing(result);
      assert.equal(result.unavailableReason, values["missing-cwd"] ? "not_git" : undefined);
      if (values.cold && !computing && !firstContentMs.has(key)) {
        firstContentMs.set(key, performance.now() - firstPollStarted.get(key)!);
      }
      if (values.mutate) {
        const modified = result.files.find((file) => file.path === "modified.txt");
        assert(modified, "mutated file must reach RPC response");
        assert.equal(
          modified.additions,
          (sequence % 5) + 1,
          "each round must return its current added-line count",
        );
        assert.equal(modified.deletions, 0);
      }
      const hash = responseHash(result);
      if (!values.mutate && !values.cold) {
        assert.equal(
          hash,
          warmupHashes[checkout],
          "unchanged polling and irrelevant churn must preserve the diff",
        );
      }
      rpcSamples.push({
        phase: measurementPhase,
        sequence,
        ...(values.cold ? {} : { round: sequence }),
        tab,
        checkout,
        elapsedMs,
        files: result.files.length,
        responseSha256: hash,
        computing,
      });
      if (values.cold && !coldToSteady && firstContentMs.size === tabs) {
        contentReadyAtMs = performance.now() - started;
        // Tag completions consistently and drain their diagnostics before changing phase.
        coldToSteady = waitForDiagnosticEventsDrained().then(() => {
          measurementPhase = "steady";
        });
      }
      return computing;
    };
    const heavyMs: number[] = [];
    const agentMs: number[] = [];
    const maintenanceMs: number[] = [];
    const churnTimings: number[] = [];
    const savedFile = path.join(repo, "unchanged.txt");
    const savedContent = churnMs ? await fs.readFile(savedFile) : undefined;
    const buildDirectory = path.join(repo, "ignored", "build");
    if (churnMs) {
      await fs.mkdir(buildDirectory, { recursive: true });
    }
    let deadline = 0;
    const repeat = async (observations: number[], run: () => Promise<unknown>) => {
      while (performance.now() < deadline) {
        const started = performance.now();
        await run();
        observations.push(performance.now() - started);
      }
    };
    measured = true;
    const cpuStarted = process.cpuUsage();
    const measurementStartedAtUnixMs = Date.now();
    const started = performance.now();
    deadline = started + durationMs;
    await Promise.all([
      ...(savedContent
        ? [
            (async () => {
              for (let round = 0; performance.now() < deadline; round++) {
                const churnStarted = performance.now();
                const saveTemporary = path.join(buildDirectory, "save.tmp");
                await fs.writeFile(saveTemporary, savedContent);
                await fs.rename(saveTemporary, savedFile);
                const buildFile = path.join(buildDirectory, `output-${round % 2}.txt`);
                await fs.writeFile(buildFile, `Synthetic ignored build ${round}\n`);
                await git("status", "--porcelain=v1");
                await fs.unlink(buildFile);
                churnTimings.push(performance.now() - churnStarted);
                await delay(Math.max(0, Math.min(churnMs, deadline - performance.now())));
              }
            })(),
          ]
        : []),
      ...Array.from({ length: background }, () =>
        repeat(heavyMs, () =>
          runGitWorkerOperation({ type: "checkout.diff", input: { cwd: heavyRepo, scope: "all" } }),
        ),
      ),
      ...Array.from({ length: maintenance }, () =>
        repeat(maintenanceMs, () =>
          withContentGitSlot(() =>
            runGitBuffered(heavyRepo, ["diff", "--numstat", "HEAD"], {
              lowerPriority: true,
              operation: "worktree.maintenance",
            }),
          ),
        ),
      ),
      ...Array.from({ length: agents }, () =>
        repeat(agentMs, async () => {
          for (const args of [
            ["status", "--porcelain=v1"],
            ["diff", "--stat", "HEAD"],
            ["log", "-1", "--format=%H"],
          ]) {
            await promisify(execFile)("git", ["-C", heavyRepo, ...args], { env: gitEnv });
          }
        }),
      ),
      (async () => {
        if (values.cold) {
          await Promise.all(
            peers.map(async (_peer, tab) => {
              const checkout = tab % targets.length;
              let refreshStarted = performance.now();
              let refreshPhase = measurementPhase;
              for (let sequence = 0; performance.now() < deadline; sequence++) {
                const computing = await sampleRpc(tab, checkout, sequence);
                if (!computing) {
                  refreshSamples.push({
                    phase: refreshPhase,
                    tab,
                    checkout,
                    startedAtMs: refreshStarted - started,
                    elapsedMs: performance.now() - refreshStarted,
                  });
                }
                if (coldToSteady) {
                  await coldToSteady;
                }
                await delay(
                  Math.max(0, Math.min(computing ? 500 : pollMs, deadline - performance.now())),
                );
                if (!computing) {
                  // Include computing retries and timer delays, but exclude the refresh cadence.
                  refreshStarted = performance.now();
                  refreshPhase = measurementPhase;
                }
              }
            }),
          );
          return;
        }
        for (let round = 0; performance.now() < deadline; round++) {
          if (pollMs) {
            await delay(pollMs);
          }
          if (performance.now() >= deadline) {
            break;
          }
          const expectedAdditions = (round % 5) + 1;
          if (values.mutate) {
            await fs.writeFile(
              path.join(repo, "modified.txt"),
              "Synthetic tracked content\n" +
                Array.from(
                  { length: expectedAdditions },
                  (_, index) => `RPC round ${round} line ${index}\n`,
                ).join(""),
            );
          }
          if (performance.now() >= deadline) {
            break;
          }
          await Promise.all(
            peers.flatMap((_peer, tab) =>
              targets.map((_target, checkout) => sampleRpc(tab, checkout, round)),
            ),
          );
        }
      })(),
    ]);
    const elapsedMs = performance.now() - started;
    const cpuUsed = process.cpuUsage(cpuStarted);
    const processCpuMs = (cpuUsed.user + cpuUsed.system) / 1_000;
    await waitForDiagnosticEventsDrained();
    measured = false;
    if (values.cold) {
      const verifiedResults = await readTargets();
      const verifiedHashes = verifiedResults.map(responseHash);
      for (const [index, result] of verifiedResults.entries()) {
        verifyContent(result, index);
      }
      for (const sample of rpcSamples) {
        if (!sample.computing) {
          assert.equal(
            sample.responseSha256,
            verifiedHashes[sample.checkout],
            "every materialized cold and steady response must match verified content",
          );
        }
      }
    }
    let missingRecoveryMs: number | null = null;
    if (values["missing-cwd"]) {
      await fs.rename(path.join(repo, "missing-cwd-saved"), path.join(repo, "new"));
      const recoveryStarted = performance.now();
      for (;;) {
        const result = await peers[0]!.request<
          import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult
        >("sessions.diff", targets[0]!.params);
        const recoveryMs = performance.now() - recoveryStarted;
        assert(recoveryMs < 2_000, "recreated cwd must recover within two seconds");
        if (
          !result.unavailableReason &&
          result.files.some((file) => file.path === "modified.txt")
        ) {
          missingRecoveryMs = recoveryMs;
          break;
        }
        await delay(50);
      }
    }
    let editControlVerified = false;
    let editFirstPollVisible: boolean[] = [];
    let editVisibilityMs: number[] = [];
    if (churnMs) {
      const changedFile = savedFile;
      const originalContent = await fs.readFile(changedFile);
      try {
        await fs.writeFile(
          changedFile,
          "Synthetic tracked content\nReal edit one\nReal edit two\n",
        );
        const editStarted = performance.now();
        const editDeadline = editStarted + 12_000;
        const visibility = await Promise.all(
          peers.map(async (peer) => {
            let firstPollVisible = false;
            for (let poll = 0; ; poll++) {
              const remainingMs = editDeadline - performance.now();
              if (remainingMs <= 0) {
                return {
                  firstPollVisible,
                  visible: false,
                  elapsedMs: performance.now() - editStarted,
                };
              }
              const result = await peer
                .request<import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult>(
                  "sessions.diff",
                  targets[0]!.params,
                  { timeoutMs: remainingMs },
                )
                .catch(() => undefined);
              const visible =
                result?.files.find((file) => file.path === "unchanged.txt")?.additions === 2;
              if (poll === 0) {
                firstPollVisible = visible;
              }
              const receivedAt = performance.now();
              const timelyVisible = visible && receivedAt <= editDeadline;
              if (!result || timelyVisible || receivedAt >= editDeadline) {
                return {
                  firstPollVisible,
                  visible: timelyVisible,
                  elapsedMs: receivedAt - editStarted,
                };
              }
              await delay(Math.min(250, editDeadline - receivedAt));
            }
          }),
        );
        editFirstPollVisible = visibility.map((result) => result.firstPollVisible);
        editVisibilityMs = visibility.map((result) => result.elapsedMs);
        editControlVerified = visibility.every((result) => result.visible);
      } finally {
        await fs.writeFile(changedFile, originalContent);
      }
    }
    let excludesFileControlVerified: boolean | null = null;
    if ("excludesFile" in fixture && fixture.excludesFile === true) {
      const excludesPath = path.join(root, "git-excludes");
      const original = await fs.readFile(excludesPath);
      try {
        await fs.writeFile(excludesPath, "");
        const results = await Promise.all(
          peers.map((peer) =>
            peer.request<import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult>(
              "sessions.diff",
              targets[0]!.params,
            ),
          ),
        );
        excludesFileControlVerified = results.every((result) =>
          result.files.some((file) => file.path === "external-ignored.txt" && file.additions === 1),
        );
      } finally {
        await fs.writeFile(excludesPath, original);
      }
    }
    assert(
      rpcSamples.length > 0,
      "No RPC polls completed; reduce --poll-ms or extend --duration-ms",
    );
    const operationName = (sample: Record<string, unknown>) =>
      sample.operation === "checkout.diff"
        ? `${sample.operation}:${sample.summaryOnly === true ? "summary" : sample.summaryOnly === false ? "full" : "unspecified"}`
        : String(sample.operation);
    const byOperation = Object.fromEntries(
      [...new Set(operationSamples.map(operationName))].map((operation) => {
        const entries = operationSamples.filter((sample) => operationName(sample) === operation);
        return [
          operation,
          Object.fromEntries(
            [
              "elapsedMs",
              "workerQueueWaitMs",
              "summedGitWallMs",
              "summedGitQueueWaitMs",
              "gitCommandCount",
            ].flatMap((field) => {
              const numbers = entries
                .map((entry) => entry[field])
                .filter((value): value is number => typeof value === "number");
              return numbers.length ? [[field, summarize(numbers)]] : [];
            }),
          ),
        ];
      }),
    );
    const sequenceMaxMs = new Map<number, number>();
    for (const sample of rpcSamples) {
      sequenceMaxMs.set(
        sample.sequence,
        Math.max(sequenceMaxMs.get(sample.sequence) ?? 0, sample.elapsedMs),
      );
    }
    const cacheSamples = phaseSamples.filter((sample) => sample.name === "sessions.diff");
    const cacheHits = cacheSamples.filter(
      (sample) => sample.details.outcome === "cache-hit",
    ).length;
    const cacheMisses = cacheSamples.filter((sample) => sample.details.outcome === "cache-miss");
    if (readCacheOwner) {
      assert(readCacheOwnerLoads > 0, "the selected Git read-cache owner was not loaded");
    }
    const phases = Object.fromEntries(
      (["cold", "steady"] as const).map((phase) => {
        const entries = rpcSamples.filter((sample) => sample.phase === phase);
        const handlers = cacheSamples.filter((sample) => sample.phase === phase);
        const refreshes = refreshSamples.filter((sample) => sample.phase === phase);
        return [
          phase,
          {
            completedRpc: entries.length,
            computingResponses: entries.filter((sample) => sample.computing).length,
            rpcLatencyMs: entries.length
              ? summarize(entries.map((sample) => sample.elapsedMs))
              : null,
            handlerCount: handlers.length,
            handlerSeconds: handlers.reduce((sum, sample) => sum + sample.durationMs, 0) / 1000,
            ...(values.cold
              ? {
                  completedRefreshes: refreshes.length,
                  refreshLatencyMs: refreshes.length
                    ? summarize(refreshes.map((sample) => sample.elapsedMs))
                    : null,
                }
              : {}),
          },
        ];
      }),
    );
    const report = {
      revision: values.revision ?? null,
      boundary: "rpc",
      coldStart: values.cold === true,
      readCacheOwner: readCacheOwner ?? null,
      readCacheOwnerLoads,
      poll: values.poll === true,
      scope,
      summaryOnly: values.summary === true,
      fixture,
      extraFixtures,
      checkoutCount: checkoutRoots.length,
      tabs,
      background,
      agents,
      maintenance,
      churnMs,
      missingCwd: values["missing-cwd"] === true,
      missingRecoveryMs,
      completedChurn: churnTimings.length,
      churnLatencyMs: churnTimings.length ? summarize(churnTimings) : null,
      editControlVerified,
      editFirstPollVisible,
      editVisibilityMs,
      excludesFileControlVerified,
      durationMs,
      measurementStartedAtUnixMs,
      warmupRpcMs,
      ...(values.cold
        ? {
            firstRequestLatencyMs: summarize(
              rpcSamples
                .filter((sample) => sample.sequence === 0)
                .map((sample) => sample.elapsedMs),
            ),
            firstContentLatencyMs: firstContentMs.size
              ? summarize([...firstContentMs.values()])
              : null,
            contentReadyClients: firstContentMs.size,
            contentReadyAtMs,
            expectedContentClients: tabs,
            checkoutByTab: peers.map((_peer, tab) => tab % targets.length),
            computingRetryMs: 500,
            contentVerified: true,
          }
        : {}),
      phases,
      completedRpc: rpcSamples.length,
      rpcPerMinute: (rpcSamples.length * 60_000) / elapsedMs,
      ...(values.cold
        ? {
            completedPollSequences: sequenceMaxMs.size,
            rpcPollSequenceMaxLatencyMs: summarize([...sequenceMaxMs.values()]),
          }
        : {
            completedRounds: sequenceMaxMs.size,
            rpcRoundLatencyMs: summarize([...sequenceMaxMs.values()]),
          }),
      completedHeavy: heavyMs.length,
      completedAgent: agentMs.length,
      completedMaintenance: maintenanceMs.length,
      heavyOpsPerSecond: (heavyMs.length * 1000) / durationMs,
      agentOpsPerSecond: (agentMs.length * 1000) / durationMs,
      maintenanceOpsPerSecond: (maintenanceMs.length * 1000) / durationMs,
      mutate: values.mutate === true,
      pollMs,
      node: process.version,
      elapsedMs,
      processCpuMs,
      processCpuMsPerRpc: processCpuMs / rpcSamples.length,
      rpcLatencyMs: summarize(rpcSamples.map((sample) => sample.elapsedMs)),
      heavyContentMs: heavyMs.length ? summarize(heavyMs) : null,
      agentGitMs: agentMs.length ? summarize(agentMs) : null,
      maintenanceGitMs: maintenanceMs.length ? summarize(maintenanceMs) : null,
      byOperation,
      diffPhases: Object.fromEntries(
        [...new Set(phaseSamples.map((sample) => `${sample.name}:${sample.details.outcome}`))].map(
          (key) => {
            const entries = phaseSamples.filter(
              (sample) => `${sample.name}:${sample.details.outcome}` === key,
            );
            return [
              key,
              Object.fromEntries([
                ["durationMs", summarize(entries.map((sample) => sample.durationMs))],
                ...[
                  "admission",
                  "checkout-resolve",
                  "cache-validate",
                  "worker-queue",
                  "git-wall",
                  "encode",
                ].flatMap((stage) => {
                  const numbers = entries
                    .map((sample) => sample.details[stage])
                    .filter((value): value is number => typeof value === "number");
                  return numbers.length ? [[stage, summarize(numbers)]] : [];
                }),
              ]),
            ];
          },
        ),
      ),
      cache: {
        hits: cacheHits,
        misses: cacheMisses.length,
        hitRate: cacheSamples.length ? cacheHits / cacheSamples.length : null,
        missReasons: Object.fromEntries(
          [
            ...new Set(
              cacheMisses.map((sample) => String(sample.details.missReason ?? "unreported")),
            ),
          ].map((reason) => [
            reason,
            cacheMisses.filter(
              (sample) => String(sample.details.missReason ?? "unreported") === reason,
            ).length,
          ]),
        ),
      },
      rpcSamples,
      ...(values.cold ? { refreshSamples } : {}),
      operationSamples,
      phaseSamples,
    };
    await fs.writeFile(
      path.resolve(values.output ?? path.join(root, "result.json")),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        rpcLatencyMs: report.rpcLatencyMs,
        phases,
        ...(values.cold
          ? {
              firstRequestLatencyMs: report.firstRequestLatencyMs,
              firstContentLatencyMs: report.firstContentLatencyMs,
            }
          : {}),
        agentGitMs: report.agentGitMs,
        byOperation,
        diffPhases: report.diffPhases,
      }),
    );
    if (churnMs) {
      assert(editControlVerified, "a real post-churn edit must reach every tab within 12 seconds");
    }
    if (values.cold) {
      assert.equal(
        firstContentMs.size,
        tabs,
        "every cold client must receive materialized content during the measurement window",
      );
      assert(
        refreshSamples.some((sample) => sample.phase === "steady"),
        "extend --duration-ms to include steady polling after all cold clients receive content",
      );
    }
    assert(excludesFileControlVerified !== false, "an external ignore edit must reach every tab");
  } finally {
    if (values["missing-cwd"]) {
      await fs
        .rename(path.join(repo, "missing-cwd-saved"), path.join(repo, "new"))
        .catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        });
    }
    stopPhases();
    operationChannel.unsubscribe(observe);
    for (const peer of peers) {
      peer.stop();
    }
    await server.close();
    await drainGlobalSingletonLifecycleState();
  }
}

await (values.seed ? seed() : measure());
