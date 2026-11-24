/**
 * Isolated built-Gateway companion to placement-startup-wake-measure.ts.
 * First generate a team-shape fixture with --sessions 10000 --local-placements 1000.
 * node --import ./scripts/tsx.mjs scripts/perf/placement-startup-wake-gateway-measure.ts \
 *   --state-dir /new/synthetic/fixture --entry /built/revision/dist/entry.js --port 42761
 * Run base/base/candidate serially on the same synthetic fixture. No external provider.
 * Lease tombstones enter the real publication owner; startup owns the parked lookups.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";

const channel = "placement-startup-wake-bench";
if (process.env.OPENCLAW_BENCH_STARTUP_WAKE === "1") {
  if (isMainThread) {
    assert(process.send && global.gc, "requires IPC and --expose-gc");
    const measurePublications = async () => {
      // Source and build share the Symbol.for("openclaw.stateDomainPublication.worktree-registry") slot.
      const { worktreeRegistryPublication } =
        await import("../../src/agents/worktrees/registry-publication.ts");
      const { openTrackedStateDatabase } =
        await import("../../src/state/openclaw-state-db-handle.ts");
      const db = openTrackedStateDatabase(":memory:");
      const leases = [{ scope: "worktree-run:synthetic", lease_key: "synthetic-run" }];
      const publish = (count: number) => {
        for (let index = 0; index < count; index++) {
          worktreeRegistryPublication.deleted(db, leases);
        }
      };
      const inspector = new Session();
      inspector.connect();
      try {
        publish(20_000);
        global.gc!();
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        publish(50_000);
        const elapsedMs = performance.now() - start;
        const used = process.threadCpuUsage(cpu);
        global.gc!();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        publish(5000);
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        let bytes = 0;
        let startupOwnerBytes = 0;
        const visit = (node: typeof profile.head, inOwner = false) => {
          const inStartupOwner =
            inOwner || node.callFrame.url.includes("server-worker-placement-startup-");
          bytes += node.selfSize;
          if (inStartupOwner) {
            startupOwnerBytes += node.selfSize;
          }
          for (const child of node.children) {
            visit(child, inStartupOwner);
          }
        };
        visit(profile.head);
        process.send!({
          channel,
          loadavg: loadavg(),
          elapsedMs,
          cpuUsPerInstall: (used.user + used.system) / 50_000,
          sampledBytesPerInstall: bytes / 5000,
          startupOwnerBytesPerInstall: startupOwnerBytes / 5000,
        });
      } finally {
        inspector.disconnect();
        db.close();
      }
    };
    process.on("message", (message) => {
      if (message === channel) {
        void measurePublications().catch((error: unknown) => {
          process.send!({ channel, error: String(error) });
        });
      }
    });
    process.channel?.unref();
  }
} else {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      entry: { type: "string" },
      port: { type: "string", default: "42761" },
    },
  });
  assert(values["state-dir"] && values.entry);
  const root = path.resolve(values["state-dir"]);
  const summary = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
  assert(summary.format === "openclaw-team-shape-v1" && summary.sessionCount >= 10000);
  // Offline synthetic setup: preserve sessions while making their startup workspace unavailable.
  const db = new DatabaseSync(path.join(root, "agents/main/agent/openclaw-agent.sqlite"));
  db.exec(`UPDATE session_nodes SET entry_json = json_set(entry_json,
    '$.worktree', json_object('id', 'parked-' || current_session_id,
    'branch', 'synthetic', 'repoRoot', '/synthetic/missing'))`);
  db.close();
  const port = Number(values.port);
  assert(Number.isSafeInteger(port) && port >= 40000 && port <= 65535);
  const log = createWriteStream(path.join(root, "startup-wake-gateway.log"));
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(path.resolve(values.entry), port, [
      "--expose-gc",
      "--import",
      path.resolve("scripts/tsx.mjs"),
      "--import",
      fileURLToPath(import.meta.url),
    ]),
    {
      env: createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
        caseEnv: {
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_PROFILE: `startup-wake-${port}`,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_BENCH_STARTUP_WAKE: "1",
        },
      }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  try {
    const startAt = performance.now();
    const ready = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt,
      deadlineAt: startAt + 180_000,
      isDone: () => child.exitCode !== null,
    });
    assert.equal(ready.status, 200, "Gateway readiness failed; inspect startup-wake-gateway.log");
    // The normal minute sweep performs initial orphan discovery after readiness.
    await delay(90_000);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("publication probe timed out")), 60_000);
      child.on("message", (message) => {
        if (
          typeof message === "object" &&
          message &&
          "channel" in message &&
          message.channel === channel
        ) {
          clearTimeout(timer);
          if ("error" in message) {
            reject(new Error(String(message.error)));
          } else {
            resolve(message);
          }
        }
      });
      child.send(channel);
    });
    console.log(JSON.stringify({ entry: values.entry, readinessMs: ready.ms, result }));
  } finally {
    await stopChild(child, { teardownGraceMs: 30_000 });
    log.end();
  }
}
