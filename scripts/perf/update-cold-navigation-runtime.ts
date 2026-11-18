// Invoked only by update-doctor-generation-measure.ts; see perf/README.md.
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { runCancelableCommand } from "../lib/cancelable-command.mts";
import { toErrorObject } from "../lib/error-format.mts";
import {
  getFreePort,
  readGatewayBenchHostCounters,
  requestProbeStatus,
} from "../lib/gateway-bench-probes.ts";
import {
  hasUnjoinedWork,
  runManagedCommand,
  terminateManagedChild,
} from "../lib/managed-child-process.mts";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const artifact = z.strictObject({
  tarball: z.string().min(1),
  sha256: digest,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceSnapshotSha256: digest,
  qualificationReceipt: z.string().min(1),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  outputRoot: z.string().min(1),
  pairs: z.number().int().min(5).max(10),
  nodeVersion: z.string().min(1),
  nodeSha256: digest,
  fixtureProducerSha256: digest,
  baseline: artifact,
  candidate: artifact,
  controlledHost: z.strictObject({
    reservation: z.string().min(1),
    maxLoadPerCpu: z.number().positive(),
    maxIoFullAvg10Percent: z.number().nonnegative().max(100),
  }),
});
const packageSchema = z.object({
  name: z.literal("openclaw"),
  version: z.string(),
  openclaw: z.object({ schemaVersions: z.record(z.string(), z.number()) }),
});
const workload = {
  archives: 3,
  eventsPerArchive: 4096,
  trafficMs: 60_000,
  writers: 2,
  readers: 1,
  pauseAfterResponseMs: 50,
  rpcTimeoutMs: 10_000,
  postStartupSliceMs: 3_000,
};
const acceptance =
  "No errors, partial canonical archives, missing completion, changed archive bytes or foreign-key failures. Every user-facing metric must hold or improve; >=20% adverse movement requires investigation, not acceptance. At least five interleaved pairs; counts before timing. Host qualification is necessary, not proof that remaining differences are noise.";
const exclusions = {
  totalUpdateMs: null,
  nativeGatewayDowntimeMs: null,
  reason:
    "Installed foreground Gateway runtime only. Standalone baseline Doctor is outside startup timing. No updater/native-service handoff is exercised; startup/probe brackets are not service downtime.",
};
const producer = "scripts/perf/update-doctor-generation-measure.ts";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function hashFile(file: string) {
  const result = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    result.update(chunk);
  }
  return result.digest("hex");
}

/** Read-only qualification. Source receipts are declarations, not inferred from package versions. */
export async function planColdNavigationRuntime(manifestPath: string) {
  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const sourceRoot = fs.realpathSync(".");
  const disposableRoot = fs.realpathSync(path.join(sourceRoot, ".openclaw/tmp"));
  assert.equal(
    disposableRoot,
    path.join(sourceRoot, ".openclaw/tmp"),
    "disposable parent must not redirect outside checkout",
  );
  const outputRoot = path.resolve(manifest.outputRoot);
  assert.equal(
    path.dirname(outputRoot),
    disposableRoot,
    "outputRoot must be a fresh direct child of .openclaw/tmp",
  );
  assert.ok(
    !fs.existsSync(outputRoot) && !fs.lstatSync(outputRoot, { throwIfNoEntry: false }),
    "outputRoot already exists",
  );
  assert.equal(process.version, manifest.nodeVersion, "Node version mismatch");
  const node = fs.realpathSync(process.execPath);
  assert.equal(await hashFile(node), manifest.nodeSha256, "Node digest mismatch");
  assert.equal(
    await hashFile(producer),
    manifest.fixtureProducerSha256,
    "fixture producer mismatch",
  );
  const sourcePackage = packageSchema.parse(JSON.parse(fs.readFileSync("package.json", "utf8")));
  const bindings = [];
  for (const arm of ["baseline", "candidate"] as const) {
    const declared = manifest[arm];
    const tarball = fs.realpathSync(declared.tarball);
    assert.equal(await hashFile(tarball), declared.sha256, arm + " artifact digest mismatch");
    const metadata = packageSchema.parse(
      JSON.parse(
        execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }),
      ),
    );
    assert.deepEqual(
      metadata.openclaw.schemaVersions,
      sourcePackage.openclaw.schemaVersions,
      arm + " schema differs from fixture producer; qualify a matching-base artifact",
    );
    bindings.push({
      arm,
      ...declared,
      tarball,
      packageVersion: metadata.version,
      schemas: metadata.openclaw.schemaVersions,
    });
  }
  assert.notEqual(
    manifest.baseline.sha256,
    manifest.candidate.sha256,
    "baseline and candidate must differ",
  );
  return {
    manifest,
    sourceRoot,
    outputRoot,
    node,
    bindings,
    workload,
    acceptance,
    exclusions,
    runnerSha256: await hashFile("scripts/perf/update-cold-navigation-runtime.ts"),
    clientSha256: await hashFile("src/gateway/client.ts"),
    sourceBinding:
      "Artifact bytes, Node and fixture producer are hashed. Source commit/snapshot and qualification receipt are externally qualified declarations; this runner does not attest build provenance.",
    order: Array.from({ length: manifest.pairs }, (_, pair) =>
      ["baseline", "candidate"].map((arm) => ({ pair: pair + 1, arm })),
    ).flat(),
    cacheShape:
      "One fresh npm prefix/cache per arm, installed once before cells. Each cell has fresh HOME/state/XDG cache/workspace. OS page cache is not flushed; ABAB controls order, not cold OS-cache claims.",
  };
}

type Plan = Awaited<ReturnType<typeof planColdNavigationRuntime>>;

export type ColdRuntimeObservation = {
  requestId?: string;
  kind: "write" | "history";
  phase: "warmup" | "traffic";
  startMs: number;
  endMs: number;
  epochMs: number;
  pending: number;
  pendingAtEnd?: number;
  error?: string;
};

export function assertColdNavigationTrafficCoverage(params: {
  arm: "baseline" | "candidate";
  pending: number;
  observations: readonly ColdRuntimeObservation[];
}) {
  assert.equal(params.pending, 0, "background pass incomplete in fixed window");
  const requestsFor = (kind: "write" | "history") =>
    params.observations.flatMap((row) =>
      row.phase === "traffic" &&
      row.kind === kind &&
      row.requestId &&
      !row.error &&
      row.pending > 0 &&
      row.pendingAtEnd !== undefined &&
      row.pendingAtEnd > 0
        ? [row.requestId]
        : [],
    );
  const overlap = { write: requestsFor("write"), history: requestsFor("history") };
  if (params.arm === "candidate") {
    assert.ok(
      overlap.write.length > 0 && overlap.history.length > 0,
      "inconclusive: both measured writes and history must complete while cold work remains pending; warmup is not traffic coverage",
    );
  }
  return overlap;
}
const summary = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    count: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
};
const save = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
function hostSample(plan: Plan) {
  const counters = readGatewayBenchHostCounters();
  const io = counters.counters["pressure/io"]?.match(/^full avg10=([\d.]+)/mu);
  const [loadOneMinute] = loadavg();
  assert.ok(typeof loadOneMinute === "number");
  const loadPerCpu = loadOneMinute / availableParallelism();
  const ioFullAvg10Percent = io ? Number(io[1]) : null;
  return {
    ...counters,
    loadPerCpu,
    ioFullAvg10Percent,
    qualified:
      process.platform === "linux" &&
      ioFullAvg10Percent !== null &&
      loadPerCpu <= plan.manifest.controlledHost.maxLoadPerCpu &&
      ioFullAvg10Percent <= plan.manifest.controlledHost.maxIoFullAvg10Percent,
  };
}

async function runCell(
  plan: Plan,
  arm: "baseline" | "candidate",
  root: string,
  entry: string,
  signal: AbortSignal,
) {
  const packageRoot = path.dirname(entry);
  const state = path.join(root, "state");
  const configPath = path.join(state, "openclaw.json");
  const dbPath = path.join(state, "agents/main/agent/openclaw-agent.sqlite");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.logging = { file: path.join(root, "product.log") };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_PROFILE: "cold-runtime",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    GIT_CEILING_DIRECTORIES: path.dirname(packageRoot),
    GOMAXPROCS: "2",
    RAYON_NUM_THREADS: "2",
  };
  const { resolveSessionColdArchivePath } =
    await import("../../src/config/sessions/session-cold-storage-codec.ts");
  const { GatewayClient } = await import("../../src/gateway/client.ts");
  function inspect() {
    using db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT a.session_id,a.event_count,(SELECT count(*) FROM transcript_events e WHERE e.session_id=a.session_id) n FROM session_transcript_cold_archives a ORDER BY a.session_id",
      )
      .all();
    for (const row of rows) {
      assert.ok(row.n === 0 || row.n === row.event_count, "partial canonical archive projection");
    }
    const archives = db
      .prepare(
        "SELECT session_id,generation,archive_name,archive_sha256,archive_bytes,event_count,raw_bytes,last_seq,archived_at,storage,archive_blob FROM session_transcript_cold_archives ORDER BY session_id",
      )
      .all()
      .map(({ archive_name, storage, archive_blob, ...metadata }) => {
        assert.ok(typeof archive_name === "string");
        const bytes =
          storage === "sqlite"
            ? archive_blob
            : fs.readFileSync(resolveSessionColdArchivePath(dbPath, archive_name));
        assert.ok(bytes instanceof Uint8Array);
        return Object.assign(metadata, { payloadSha256: hash(bytes) });
      });
    return {
      pending: rows.filter((row) => row.n === 0).length,
      rows,
      archives,
      foreignKeys: db.prepare("PRAGMA foreign_key_check").all(),
    };
  }
  const initial = inspect();
  assert.equal(initial.pending, workload.archives);
  assert.equal(initial.archives.length, workload.archives);
  let doctorMs: number | null = null;
  if (arm === "baseline") {
    const log = fs.openSync(path.join(root, "baseline-doctor.log"), "w", 0o600);
    const started = performance.now();
    try {
      assert.equal(
        await runManagedCommand({
          bin: plan.node,
          args: [entry, "--profile", "cold-runtime", "doctor", "--fix", "--non-interactive"],
          cwd: packageRoot,
          env,
          stdio: ["ignore", log, log],
          timeoutMs: 180_000,
          signal,
          requireProcessTreeExit: true,
        }),
        0,
      );
      assert.equal(inspect().pending, 0);
    } finally {
      doctorMs = performance.now() - started;
      fs.closeSync(log);
    }
  }
  const initialHost = hostSample(plan);
  const host = [initialHost];
  assert.ok(initialHost.qualified, "host outside declared qualification before launch");
  const port = await getFreePort();
  const log = fs.openSync(path.join(root, "gateway-stdio.log"), "w", 0o600);
  let child: ChildProcess | undefined;
  let exited = false;
  let exitCode: number | undefined;
  let unjoined = false;
  let failure: Error | undefined;
  let shutdownMs: number;
  const started = performance.now();
  const running = runManagedCommand({
    bin: plan.node,
    args: [
      entry,
      "--profile",
      "cold-runtime",
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(port),
    ],
    cwd: packageRoot,
    env: { ...env, OPENCLAW_GATEWAY_PORT: String(port) },
    stdio: ["ignore", log, log],
    timeoutMs: 240_000,
    signal,
    requireProcessTreeExit: true,
    onReady(process) {
      child = process;
    },
  });
  void running.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  const probes: Array<{
    startMs: number;
    endMs: number;
    status: number | null;
    errorKind: string | null;
  }> = [];
  const observations: ColdRuntimeObservation[] = [];
  const transitions: Array<{
    atMs: number;
    pending: number;
    rows: ReturnType<typeof inspect>["rows"];
  }> = [];
  let readyPending = -1;
  let completeMs: number | null = null;
  let trafficEpochMs: number | null = null;
  let trafficStartMs: number | null = null;
  let overlap: ReturnType<typeof assertColdNavigationTrafficCoverage> | null = null;
  let pendingQueries = 0;
  try {
    while (performance.now() - started < 120_000) {
      signal.throwIfAborted();
      assert.ok(!exited, "Gateway exited before readiness");
      const startMs = performance.now() - started;
      const result = await requestProbeStatus(port, "/readyz");
      probes.push({ startMs, endMs: performance.now() - started, ...result });
      if (result.status === 200) {
        break;
      }
      await delay(25, undefined, { signal });
    }
    assert.equal(probes.at(-1)?.status, 200, "readiness timed out");
    readyPending = inspect().pending;
    assert.equal(
      readyPending,
      arm === "baseline" ? 0 : workload.archives,
      "readiness must precede deferred backfill",
    );
    const hello = Promise.withResolvers<void>();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:" + port,
      token: "synthetic-cold-navigation-proof",
      clientName: "cli",
      mode: "cli",
      deviceIdentity: null,
      scopes: ["operator.admin"],
      requestTimeoutMs: workload.rpcTimeoutMs,
      onHelloOk: () => hello.resolve(),
      onConnectError: (error) => hello.reject(error),
    });
    try {
      client.start();
      await Promise.race([
        hello.promise,
        delay(10_000, undefined, { signal }).then(() => {
          throw new Error("Gateway hello timed out");
        }),
      ]);
      using counts = new DatabaseSync(dbPath, { readOnly: true });
      const pendingQuery = counts.prepare(
        "SELECT count(*) n FROM session_transcript_cold_archives a WHERE NOT EXISTS(SELECT 1 FROM transcript_events e WHERE e.session_id=a.session_id)",
      );
      let previous = readyPending;
      let stopped = false;
      let nextHostSample = 0;
      const pending = () => {
        pendingQueries++;
        const row = pendingQuery.get();
        assert.ok(row && typeof row.n === "number");
        if (row.n !== previous) {
          transitions.push({
            atMs: performance.now() - started,
            pending: row.n,
            rows: inspect().rows,
          });
          previous = row.n;
        }
        if (row.n === 0) {
          completeMs ??= performance.now() - started;
        }
        return row.n;
      };
      const recordRequest = async (
        kind: "write" | "history",
        phase: "warmup" | "traffic",
        message?: string,
      ) => {
        const n = pending();
        const request: ColdRuntimeObservation = {
          kind,
          phase,
          startMs: performance.now() - started,
          endMs: 0,
          epochMs: Date.now(),
          pending: n,
        };
        try {
          await client.request(
            kind === "history" ? "chat.history" : "chat.inject",
            kind === "history"
              ? { sessionKey: "agent:main:cold-proof", limit: 10 }
              : { sessionKey: "agent:main:cold-proof", agentId: "main", message },
            {
              signal,
              onSent: (id) => {
                request.requestId = id;
              },
            },
          );
        } catch (error) {
          request.error = toErrorObject(error, "foreground request failed").message;
          throw error;
        } finally {
          request.endMs = performance.now() - started;
          observations.push(request);
          request.pendingAtEnd = pending();
        }
      };
      await recordRequest("write", "warmup", "synthetic foreground warmup");
      const trafficStart = performance.now();
      trafficStartMs = trafficStart - started;
      trafficEpochMs = performance.timeOrigin + trafficStart;
      const loop = async (index: number) => {
        let sequence = 0;
        while (performance.now() - trafficStart < workload.trafficMs) {
          if (stopped) {
            break;
          }
          signal.throwIfAborted();
          assert.ok(!exited, "Gateway exited during traffic");
          if (index === 0 && performance.now() - trafficStart >= nextHostSample) {
            host.push(hostSample(plan));
            nextHostSample += 1_000;
            assert.ok(
              host.at(-1)?.qualified,
              "host left declared qualification; retain failed cell, do not rerun silently",
            );
          }
          await recordRequest(
            index === 2 ? "history" : "write",
            "traffic",
            "synthetic foreground " + index + "-" + sequence++,
          );
          await delay(workload.pauseAfterResponseMs, undefined, { signal });
        }
      };
      const results = await Promise.allSettled(
        [0, 1, 2].map((index) =>
          loop(index).catch((error: unknown) => {
            stopped = true;
            throw error;
          }),
        ),
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        throw rejected.reason;
      }
      overlap = assertColdNavigationTrafficCoverage({ arm, pending: pending(), observations });
    } finally {
      await client.stopAndWait();
    }
  } catch (error) {
    failure = toErrorObject(error, "runtime cell failed");
  } finally {
    const stop = performance.now();
    if (child) {
      terminateManagedChild(child, "SIGTERM");
    }
    try {
      exitCode = await running;
      assert.equal(exitCode, 0, "Gateway did not shut down cleanly");
    } catch (error) {
      unjoined = hasUnjoinedWork(error);
      failure = failure
        ? new AggregateError([failure, error], "traffic and Gateway cleanup failed")
        : toErrorObject(error, "Gateway cleanup failed");
    }
    shutdownMs = performance.now() - stop;
    fs.closeSync(log);
  }
  host.push(hostSample(plan));
  if (!host.every((sample) => sample.qualified)) {
    failure ??= new Error("host outside qualification at shutdown");
  }
  let final: ReturnType<typeof inspect> | undefined;
  if (!unjoined) {
    try {
      final = inspect();
      assert.deepEqual(final.archives, initial.archives);
      assert.deepEqual(final.foreignKeys, []);
    } catch (error) {
      failure ??= toErrorObject(error, "archive verification failed");
    }
  }
  const metricFor = (kind: "write" | "history") => {
    const rows = observations.filter((row) => row.kind === kind && row.phase === "traffic");
    return {
      attempted: rows.length,
      errors: rows.filter((row) => row.error).length,
      all: summary(rows.map((row) => row.endMs - row.startMs)),
      postStartup: summary(
        rows
          .filter(
            (row) =>
              trafficStartMs !== null &&
              row.startMs >= trafficStartMs + workload.postStartupSliceMs,
          )
          .map((row) => row.endMs - row.startMs),
      ),
    };
  };
  const metrics = { write: metricFor("write"), history: metricFor("history") };
  const result = {
    arm,
    entry,
    workload,
    acceptance,
    exclusions,
    doctorMs,
    readyPending,
    readiness: {
      lastNotReady: probes.at(-2) ?? null,
      firstReady: probes.at(-1) ?? null,
      meaning:
        "Observed request intervals since launcher start; not exact readiness instant or native downtime",
    },
    trafficEpochMs,
    trafficStartMs,
    overlap,
    overlapMeaning:
      "Successful measured RPCs with pending work at both request boundaries, followed by completion. This brackets pending-window contention, not exact writer-lock overlap. Completion/transition/request times are since launcher start, not since warmup.",
    warmupMs: summary(
      observations.filter((row) => row.phase === "warmup").map((row) => row.endMs - row.startMs),
    ),
    pendingQueries,
    completeMs,
    shutdownMs,
    exitCode,
    processTreeJoined: !unjoined,
    host,
    metrics,
    probes,
    observations,
    transitions,
    initial,
    final,
    failure: failure?.message ?? null,
  };
  save(path.join(root, "runtime.json"), result);
  // The outer command removes owned fixtures only after every native child is joined.
  if (failure) {
    throw failure;
  }
  return result;
}

export async function coldNavigationRuntime(
  label: string,
  action: string | undefined,
  manifestPath: string | undefined,
) {
  assert.ok(action === "plan" || action === "run", "expected plan or run");
  assert.ok(manifestPath, "manifest path required");
  const plan = await planColdNavigationRuntime(manifestPath);
  if (action === "plan") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const before = hostSample(plan);
  assert.ok(
    before.qualified,
    "controlled Linux host with readable PSI and declared quiet slot required",
  );
  fs.mkdirSync(plan.outputRoot, { mode: 0o700 }); // Exclusive ownership: preflight never creates or empties an existing root.
  save(path.join(plan.outputRoot, "plan.json"), { label, ...plan, before });
  process.exitCode = await runCancelableCommand(async (signal) => {
    const cells: Awaited<ReturnType<typeof runCell>>[] = [];
    let failure: Error | undefined;
    let unjoined = false;
    async function command(
      args: string[],
      bin: string,
      cwd: string,
      env: NodeJS.ProcessEnv,
      logPath: string,
    ) {
      const log = fs.openSync(logPath, "w", 0o600);
      try {
        assert.equal(
          await runManagedCommand({
            bin,
            args,
            cwd,
            env,
            stdio: ["ignore", log, log],
            signal,
            timeoutMs: 600_000,
            requireProcessTreeExit: true,
          }),
          0,
          "child failed; see " + logPath,
        );
      } finally {
        fs.closeSync(log);
      }
    }
    try {
      for (const binding of plan.bindings) {
        const install = path.join(plan.outputRoot, binding.arm);
        fs.mkdirSync(install);
        await command(
          [
            "install",
            "--global",
            "--prefix",
            path.join(install, "prefix"),
            "--cache",
            path.join(install, "npm-cache"),
            "--no-audit",
            "--no-fund",
            binding.tarball,
          ],
          "npm",
          install,
          {
            ...process.env,
            PATH: path.dirname(plan.node) + path.delimiter + process.env.PATH,
            HOME: install,
            XDG_CACHE_HOME: path.join(install, "cache"),
          },
          path.join(install, "install.log"),
        );
      }
      for (const cell of plan.order) {
        signal.throwIfAborted();
        assert.ok(cell.arm === "baseline" || cell.arm === "candidate");
        const root = path.join(
          plan.outputRoot,
          (cell.arm === "baseline" ? "A" : "B") + String(cell.pair).padStart(2, "0"),
        );
        await command(
          [
            "--import",
            "./scripts/tsx.mjs",
            producer,
            label,
            "cold-navigation-fixture",
            "1",
            ".",
            root,
            String(workload.archives),
            String(workload.eventsPerArchive),
          ],
          plan.node,
          plan.sourceRoot,
          process.env,
          path.join(plan.outputRoot, path.basename(root) + "-fixture.log"),
        );
        const entry = fs.realpathSync(
          path.join(plan.outputRoot, cell.arm, "prefix/lib/node_modules/openclaw/openclaw.mjs"),
        );
        cells.push(await runCell(plan, cell.arm, root, entry, signal));
        if (cell.arm === "candidate") {
          const baseline = cells.at(-2);
          const candidate = cells.at(-1);
          assert.ok(baseline && candidate);
          const regressions: string[] = [];
          for (const kind of ["write", "history"] as const) {
            for (const slice of ["all", "postStartup"] as const) {
              for (const metric of ["median", "p95", "p99", "max"] as const) {
                const baselineValue = baseline.metrics[kind][slice][metric];
                const after = candidate.metrics[kind][slice][metric];
                if (baselineValue !== null && after !== null && after >= baselineValue * 1.2) {
                  regressions.push(kind + "." + slice + "." + metric);
                }
              }
            }
          }
          const baselineWarmup = baseline.warmupMs.max;
          const candidateWarmup = candidate.warmupMs.max;
          if (
            baselineWarmup !== null &&
            candidateWarmup !== null &&
            candidateWarmup >= baselineWarmup * 1.2
          ) {
            regressions.push("warmup.max");
          }
          save(path.join(plan.outputRoot, "pair-" + cell.pair + ".json"), {
            pair: cell.pair,
            regressions,
            verdict: regressions.length
              ? "stop: investigate adverse >=20% movement"
              : "no >=20% stop triggered; not acceptance",
          });
          assert.equal(regressions.length, 0, "adverse >=20% movement: " + regressions.join(", "));
        }
      }
    } catch (error) {
      failure = toErrorObject(error, "runtime workload failed");
      unjoined = hasUnjoinedWork(error);
    } finally {
      save(path.join(plan.outputRoot, "summary.json"), {
        label,
        bindings: plan.bindings,
        workload,
        acceptance,
        exclusions,
        completeCells: cells.length,
        expectedCells: plan.order.length,
        failure: failure?.message ?? null,
        cleanup: unjoined
          ? "retained: native extinction unverified"
          : "native processes joined; see cleanup.json for completed directory removal",
        arms: Object.fromEntries(
          ["baseline", "candidate"].map((arm) => {
            const rows = cells.filter((cell) => cell.arm === arm);
            return [
              arm,
              {
                count: rows.length,
                startupObservedUpperMs: summary(
                  rows.flatMap((cell) => cell.readiness.firstReady?.endMs ?? []),
                ),
                shutdownMs: summary(rows.map((cell) => cell.shutdownMs)),
                warmupMs: summary(rows.flatMap((cell) => cell.warmupMs.max ?? [])),
                writeP99Ms: summary(rows.flatMap((cell) => cell.metrics.write.all.p99 ?? [])),
                historyP99Ms: summary(rows.flatMap((cell) => cell.metrics.history.all.p99 ?? [])),
              },
            ];
          }),
        ),
      });
      if (!unjoined) {
        for (const arm of ["baseline", "candidate"]) {
          for (const name of ["prefix", "npm-cache", "cache"]) {
            fs.rmSync(path.join(plan.outputRoot, arm, name), { recursive: true, force: true });
          }
        }
        for (const cell of plan.order) {
          for (const name of ["home", "state", "cache", "workspace"]) {
            fs.rmSync(
              path.join(
                plan.outputRoot,
                (cell.arm === "baseline" ? "A" : "B") + String(cell.pair).padStart(2, "0"),
                name,
              ),
              { recursive: true, force: true },
            );
          }
        }
        save(path.join(plan.outputRoot, "cleanup.json"), {
          processTreesJoined: true,
          ownedStateAndInstallDirectoriesRemoved: true,
          retained: "plan, per-cell runtime/fixture/product logs, pair and summary receipts",
        });
      }
    }
    if (failure) {
      throw failure;
    }
    return 0;
  });
}
