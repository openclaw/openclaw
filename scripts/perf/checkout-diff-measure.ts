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
import { parseArgs, promisify } from "node:util";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    untracked: { type: "string", default: "100" },
    boundary: { type: "string", default: "worker" },
    summary: { type: "boolean" },
    port: { type: "string", default: "41473" },
    tabs: { type: "string", default: "3" },
    background: { type: "string", default: "8" },
    agents: { type: "string", default: "2" },
    maintenance: { type: "string", default: "2" },
    "duration-ms": { type: "string", default: "30000" },
    "observe-git-queues": { type: "boolean" },
    "heavy-files": { type: "string", default: "16" },
    "heavy-lines": { type: "string", default: "4096" },
    mutate: { type: "boolean" },
    samples: { type: "string", default: "40" },
    "poll-ms": { type: "string", default: "0" },
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
Use --boundary rpc for real sessions.diff WebSocket requests with --tabs 3,
--background 8 full-diff readers, --maintenance 2 bounded Git readers, and
--agents 2 external Git loops. --heavy-files/--heavy-lines size the seeded load
checkout. The RPC boundary starts an isolated loopback Gateway on --port >=40000.
Use --observe-git-queues to collect queue timings through benchmark-only loader
instrumentation applied identically to both revisions. No production state or model
is involved.`);
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
const root = path.resolve(values["state-dir"]);
const repo = path.join(root, "repository");
const marker = path.join(root, "checkout-diff-fixture.json");
const trace = path.join(root, "git-trace.jsonl");
const untracked = integer(values.untracked, "--untracked", 4);
if (untracked > 100) {
  throw new Error("--untracked must not exceed the 100-file diff response cap");
}
const samples = integer(values.samples, "--samples", 1);
const pollMs = integer(values["poll-ms"], "--poll-ms");
const gitEnv = {
  ...process.env,
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
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
  await git("init", "--template=", "--initial-branch=main");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  for (const file of ["modified.txt", "staged.txt", "deleted.txt"]) {
    await fs.writeFile(path.join(repo, file), "Synthetic tracked content\n");
  }
  await git("add", ".");
  await git("-c", "commit.gpgSign=false", "commit", "-m", "test: seed synthetic diff");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await fs.writeFile(path.join(repo, "modified.txt"), "Synthetic tracked content\nChanged 0\n");
  await fs.writeFile(path.join(repo, "staged.txt"), "Synthetic staged content\n");
  await git("add", "staged.txt");
  await fs.unlink(path.join(repo, "deleted.txt"));
  await fs.mkdir(path.join(repo, "new"));
  for (let index = 0; index < untracked - 4; index++) {
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

async function measure() {
  const fixture: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
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
  const input = {
    cwd: repo,
    scope: "all" as const,
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
      source = source
        .replace(
          /const enqueuedAt\s*=\s*timing\s*\?\s*performance\.now\(\)\s*:\s*0/g,
          "const enqueuedAt = performance.now()",
        )
        .replace(/const input\s*=\s*timing\s*\?/g, "const input = observedAt !== undefined ?");
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

async function measureRpc(fixture: object) {
  if (values["observe-git-queues"]) {
    observeGitQueues();
  }
  const port = integer(values.port, "--port", 40000);
  assert(port <= 65535);
  const tabs = integer(values.tabs, "--tabs", 1);
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
  ] = await Promise.all([
    import("../../src/gateway/server.js"),
    import("../../src/gateway/client.js"),
    import("../../src/infra/git-worker.js"),
    import("../../src/infra/git-content-budget.js"),
    import("../../src/agents/worktrees/git.js"),
    import("../../src/shared/global-singleton.js"),
  ]);
  const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  const peers: InstanceType<typeof GatewayClient>[] = [];
  const operationSamples: Record<string, unknown>[] = [];
  const operationChannel = channel("openclaw.git.operation");
  let measured = false;
  const observe = (event: unknown) => {
    if (measured && event !== null && typeof event === "object") {
      operationSamples.push({ ...event });
    }
  };
  operationChannel.subscribe(observe);
  try {
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
      await ready.promise;
    }
    const sessionKey = "agent:main:synthetic-diff-contention";
    await peers[0]!.request("sessions.create", {
      key: sessionKey,
      cwd: repo,
      visibility: "shared",
    });
    const params = { sessionKey, scope: "all", summaryOnly: true };
    await peers[0]!.request("sessions.diff", params);
    await Promise.all(
      Array.from({ length: Math.max(1, background) }, () =>
        runGitWorkerOperation({ type: "checkout.diff", input: { cwd: heavyRepo, scope: "all" } }),
      ),
    );
    console.log(
      JSON.stringify({ ready: true, boundary: "rpc", tabs, background, agents, maintenance }),
    );
    if (values["start-at"]) {
      const startAt = integer(values["start-at"], "--start-at", 1);
      assert(startAt > Date.now(), "pair deadline must follow Gateway preparation");
      await delay(startAt - Date.now());
    }
    const rpcSamples: {
      round: number;
      tab: number;
      elapsedMs: number;
      files: number;
      responseSha256: string;
    }[] = [];
    const heavyMs: number[] = [];
    const agentMs: number[] = [];
    const maintenanceMs: number[] = [];
    let deadline = 0;
    const repeat = async (observations: number[], run: () => Promise<unknown>) => {
      while (performance.now() < deadline) {
        const started = performance.now();
        await run();
        observations.push(performance.now() - started);
      }
    };
    measured = true;
    const started = performance.now();
    deadline = started + durationMs;
    await Promise.all([
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
            peers.map(async (peer, tab) => {
              const pollStarted = performance.now();
              const result = await peer.request<
                import("../../packages/gateway-protocol/src/index.js").SessionsDiffResult
              >("sessions.diff", params);
              assert.equal(result.unavailableReason, undefined);
              if (values.mutate) {
                const modified = result.files.find((file) => file.path === "modified.txt");
                assert(modified, "mutated file must reach RPC response");
                assert.equal(
                  modified.additions,
                  expectedAdditions,
                  "each round must return its current added-line count",
                );
                assert.equal(modified.deletions, 0);
              }
              const { root: _root, ...portable } = result;
              rpcSamples.push({
                round,
                tab,
                elapsedMs: performance.now() - pollStarted,
                files: result.files.length,
                responseSha256: createHash("sha256").update(JSON.stringify(portable)).digest("hex"),
              });
            }),
          );
        }
      })(),
    ]);
    measured = false;
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
    const roundMaxMs = new Map<number, number>();
    for (const sample of rpcSamples) {
      roundMaxMs.set(sample.round, Math.max(roundMaxMs.get(sample.round) ?? 0, sample.elapsedMs));
    }
    const report = {
      revision: values.revision ?? null,
      boundary: "rpc",
      fixture,
      tabs,
      background,
      agents,
      maintenance,
      durationMs,
      completedRpc: rpcSamples.length,
      completedRounds: roundMaxMs.size,
      completedHeavy: heavyMs.length,
      completedAgent: agentMs.length,
      completedMaintenance: maintenanceMs.length,
      heavyOpsPerSecond: (heavyMs.length * 1000) / durationMs,
      agentOpsPerSecond: (agentMs.length * 1000) / durationMs,
      maintenanceOpsPerSecond: (maintenanceMs.length * 1000) / durationMs,
      mutate: values.mutate === true,
      pollMs,
      node: process.version,
      elapsedMs: performance.now() - started,
      rpcLatencyMs: summarize(rpcSamples.map((sample) => sample.elapsedMs)),
      rpcRoundLatencyMs: summarize([...roundMaxMs.values()]),
      heavyContentMs: heavyMs.length ? summarize(heavyMs) : null,
      agentGitMs: agentMs.length ? summarize(agentMs) : null,
      maintenanceGitMs: maintenanceMs.length ? summarize(maintenanceMs) : null,
      byOperation,
      rpcSamples,
      operationSamples,
    };
    await fs.writeFile(
      path.resolve(values.output ?? path.join(root, "result.json")),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        rpcLatencyMs: report.rpcLatencyMs,
        agentGitMs: report.agentGitMs,
        byOperation,
      }),
    );
  } finally {
    operationChannel.unsubscribe(observe);
    for (const peer of peers) {
      peer.stop();
    }
    await server.close();
    await drainGlobalSingletonLifecycleState();
  }
}

await (values.seed ? seed() : measure());
