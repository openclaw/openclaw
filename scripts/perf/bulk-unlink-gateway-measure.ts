/**
 * Real projection replacement alongside sessions.patch over Gateway WebSocket.
 * Compile bulk-unlink-delay.c, then run with --delay-library <absolute library>.
 * --baseline-module is the pinned parent's local-workspace-checkout.ts, saved
 * beside the candidate module so its relative imports retain their meaning.
 * --fixture-state and --fixture-tree reuse completed synthetic inputs only.
 * Each sample receives a fresh copy (reflink where supported) of the 62k-file tree.
 * A/A controls and five serial A/B pairs use fresh 62k-file/1.14GB trees.
 * Acceptance: candidate has zero Gateway unlink workers during the injected
 * one-second stall; concurrent patch/file-write tails stay below 250ms.
 * Normal owner CPU/allocation/latency regressions >20% require owner acceptance.
 * Fixture creation and Gateway startup are excluded. No external models or data.
 */
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  summarizeNumbers,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "fixture-state": { type: "string" },
    "fixture-tree": { type: "string" },
    "baseline-module": { type: "string" },
    "delay-library": { type: "string" },
    child: { type: "boolean" },
    port: { type: "string" },
    files: { type: "string", default: "62000" },
    sessions: { type: "string", default: "5000" },
    pairs: { type: "string", default: "5" },
    "transcript-bytes": { type: "string", default: String(35 * 1024 ** 3) },
  },
});
assert(values.output && values["baseline-module"] && values["delay-library"]);
const output = path.resolve(values.output);
const stateDir = path.resolve(values["fixture-state"] ?? path.join(output, "state"));
const files = Number(values.files);
const pairs = Number(values.pairs);
const source = path.join(output, "source");
const projection = path.join(output, "projection");
const tree = path.resolve(values["fixture-tree"] ?? path.join(output, "tree"));
const labelPrefix = path.basename(output);
const key = `agent:main:bulk-unlink-proof-${labelPrefix}`;
const baseline = pathToFileURL(path.resolve(values["baseline-module"])).href;
const candidate = new URL(
  "../../src/gateway/worker-environments/local-workspace-checkout.ts",
  import.meta.url,
).href;
type Sample = { name: string; mode: string; injected: boolean };

if (values.child) {
  assert(typeof process.send === "function");
  if (!values["fixture-state"]) {
    const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
    await seedTeamShapeSessions({
      stateDir,
      sessions: Number(values.sessions),
      retainedRuns: 0,
      seed: 2725,
      now: Date.now(),
      transcriptBytes: Number(values["transcript-bytes"]),
    });
  }
  const { startGatewayServer } = await import("../../src/gateway/server.ts");
  const server = await startGatewayServer(Number(values.port), {
    bind: "loopback",
    controlUiEnabled: false,
  });
  const modules = { before: await import(baseline), after: await import(candidate) };
  const baseCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  process.on("message", (message: Sample | "stop") => {
    if (message === "stop") {
      void server.close().then(() => process.disconnect?.());
      return;
    }
    void (async () => {
      const { name, mode } = message;
      const allocation = getHeapStatistics().total_allocated_bytes;
      const cpu = process.cpuUsage();
      const mainCpu = process.threadCpuUsage();
      const started = performance.now();
      const writes: number[] = [];
      const running = new AbortController();
      const writer = (async () => {
        while (!running.signal.aborted) {
          const at = performance.now();
          await fs.promises.writeFile(path.join(output, "foreground-write"), name);
          writes.push(performance.now() - at);
          await pause(10);
        }
      })();
      try {
        const owner = mode === "before" ? modules.before : modules.after;
        await owner.initializeLocalWorkspaceProjection({
          source,
          projectionPath: projection,
          baseCommit,
          signal: new AbortController().signal,
          assertCurrent() {},
          buildCacheInputs: async () => [],
          owner: {
            agentId: "main",
            sessionKey: key,
            sessionId: "proof",
            lifecycleRevision: null,
            assertCurrent() {},
            env: process.env,
            worktree: {
              id: "00000000-0000-4000-8000-000000002725",
              name: "proof",
              repoRoot: source,
              repoFingerprint: "0123456789abcdef",
              path: source,
              branch: "proof",
              baseRef: "HEAD",
              ownerKind: "session",
              ownerId: key,
              createdAt: 1,
              lastActiveAt: 1,
            },
          },
        });
        const ownerMs = performance.now() - started;
        running.abort();
        await writer;
        const used = process.cpuUsage(cpu);
        const main = process.threadCpuUsage(mainCpu);
        process.send?.({
          name,
          pid: process.pid,
          ownerMs,
          cpuMs: (used.user + used.system) / 1000,
          mainCpuMs: (main.user + main.system) / 1000,
          allocatedBytes: getHeapStatistics().total_allocated_bytes - allocation,
          writesMs: summarizeNumbers(writes),
          writeSamples: writes,
        });
      } catch (error) {
        process.send?.({ name, error: String(error) });
      } finally {
        running.abort();
        await writer;
      }
    })();
  });
  process.send({ ready: true, pid: process.pid });
} else {
  fs.mkdirSync(output);
  for (const name of ["source", "tmp", "home"]) {
    fs.mkdirSync(path.join(output, name));
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "-q", "--template=", "-b", "main");
  fs.writeFileSync(path.join(source, "README.md"), "Synthetic source\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const configPath = path.join(output, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...BASE_GATEWAY_BENCH_CONFIG,
      agents: {
        defaults: { model: { primary: "synthetic/model" } },
        entries: { main: { workspace: source } },
      },
      plugins: { enabled: false },
      cron: { enabled: false },
    }),
  );
  if (!values["fixture-tree"]) {
    const bytes = Buffer.alloc(18432, 97);
    for (let i = 0; i < files; i++) {
      const directory = path.join(tree, "node_modules", `package-${Math.floor(i / 100)}`, "lib");
      if (i % 100 === 0) {
        fs.mkdirSync(directory, { recursive: true });
        await pause(0);
      }
      fs.writeFileSync(path.join(directory, String(i)), bytes);
    }
  }
  const port = await getFreePort();
  const library = path.resolve(values["delay-library"]);
  // Removable fixture volumes may have shared writable ancestors. Keep the
  // runtime's private cache namespace under the OS-owned per-user temp root.
  const cacheRoot = fs.mkdtempSync(path.join(tmpdir(), "bulk-unlink-cache-"));
  const child = fork(
    fileURLToPath(import.meta.url),
    [...process.argv.slice(2), "--child", "--port", String(port)],
    {
      env: createGatewayBenchEnv(path.join(output, "home"), configPath, {
        caseEnv: {
          OPENCLAW_STATE_DIR: stateDir,
          XDG_CACHE_HOME: cacheRoot,
          UV_THREADPOOL_SIZE: "4",
          BULK_UNLINK_LOG: path.join(output, "unlink.log"),
          BULK_UNLINK_METRICS: path.join(output, "children.jsonl"),
          NODE_OPTIONS: `--import=${new URL("./bulk-unlink-child-metrics.mjs", import.meta.url).href}`,
          [process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"]: library,
        },
      }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const log = fs.createWriteStream(path.join(output, "gateway.log"));
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  let peer: ReturnType<typeof createGatewayWsClient> | undefined;
  const results: unknown[] = [];
  try {
    const [ready] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(90 * 60_000) }),
      once(child, "exit").then(([code]) => {
        throw new Error(`Gateway exited before readiness: ${code}`);
      }),
    ]);
    assert(ready.ready, JSON.stringify(ready));
    const probeStart = performance.now();
    const readiness = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: probeStart,
      deadlineAt: probeStart + 120_000,
      isDone: () => child.exitCode !== null || child.signalCode !== null,
    });
    assert.equal(readiness.status, 200, "Gateway admission did not become ready");
    peer = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    await peer.waitOpen();
    const rpc = async (method: string, params: unknown) => {
      const reply = await peer!.request(method, params, 60_000);
      assert(reply.ok, JSON.stringify(reply.error));
      return reply.payload;
    };
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "gateway-client", version: "dev", platform: process.platform, mode: "backend" },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    });
    await rpc("sessions.create", {
      key,
      visibility: "shared",
      displayName: "Synthetic removal proof",
    });
    let revision = 0;
    const samples: Sample[] = [
      { name: "warm-before", mode: "before", injected: false },
      { name: "warm-after", mode: "after", injected: false },
      ...["aa1", "aa2"].map((name) => ({
        name,
        mode: "before",
        injected: false,
      })),
    ];
    for (let i = 0; i < pairs; i++) {
      for (const mode of ["before", "after"]) {
        samples.push({ name: `${mode}-${i}`, mode, injected: false });
      }
    }
    for (const mode of ["before", "after"]) {
      samples.push({ name: `slow-${mode}`, mode, injected: true });
    }
    for (const sample of samples) {
      await fs.promises.rm(projection, { recursive: true, force: true });
      await fs.promises.cp(tree, projection, {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
      if (sample.injected) {
        for (let i = 0; i < 4; i++) {
          fs.writeFileSync(path.join(projection, `slow-unlink-${sample.name}-${i}`), "x");
        }
      }
      const control: number[] = [];
      for (let i = 0; i < 10; i++) {
        const at = performance.now();
        await rpc("sessions.patch", { key, label: `${labelPrefix}-${revision++}` });
        control.push(performance.now() - at);
      }
      const running = new AbortController();
      const patches: number[] = [];
      const reply = once(child, "message", { signal: AbortSignal.timeout(120_000) });
      const load = loadavg();
      const startedAt = Date.now();
      child.send(sample);
      const patcher = (async () => {
        while (!running.signal.aborted) {
          const at = performance.now();
          await rpc("sessions.patch", { key, label: `${labelPrefix}-${revision++}` });
          patches.push(performance.now() - at);
          await pause(10);
        }
      })();
      const [result] = await reply;
      running.abort();
      await patcher;
      assert(!result.error, result.error);
      const childMetrics = fs.existsSync(path.join(output, "children.jsonl"))
        ? fs
            .readFileSync(path.join(output, "children.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map(
              (line) => JSON.parse(line) as { at: number; cpuMs: number; allocatedBytes: number },
            )
            .filter((entry) => entry.at >= startedAt)
        : [];
      results.push({
        ...sample,
        ...result,
        load,
        childCpuMs: childMetrics.reduce((sum, entry) => sum + entry.cpuMs, 0),
        childAllocatedBytes: childMetrics.reduce((sum, entry) => sum + entry.allocatedBytes, 0),
        removalChildren: childMetrics.length,
        controlMs: summarizeNumbers(control),
        patchMs: summarizeNumbers(patches),
        patchSamples: patches,
      });
      fs.writeFileSync(
        path.join(output, "results.json"),
        JSON.stringify(
          {
            revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            files,
            bytes: files * 18432,
            sessions: values.sessions,
            databaseBytes: fs.statSync(
              path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
            ).size,
            sourceHashes: Object.fromEntries(
              [
                baseline,
                candidate,
                new URL("../../src/agents/worktrees/filesystem-native.ts", import.meta.url).href,
                new URL("../../src/infra/fs-safe-copy.worker.ts", import.meta.url).href,
              ].map((url) => [
                url,
                createHash("sha256")
                  .update(fs.readFileSync(new URL(url)))
                  .digest("hex"),
              ]),
            ),
            results,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally {
    peer?.close();
    if (child.connected) {
      const closed = once(child, "close");
      child.send("stop");
      await Promise.race([closed, pause(10_000)]);
    }
    if (child.exitCode === null) {
      await stopChild(child);
    }
    log.end();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}
