/**
 * Cold built-Gateway boot comparison, with fresh synthetic 10,800-session state
 * and 40 enabled bundled plugins per arm (provider activation remains lazy).
 * No real state, credentials, or model calls.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/state-read-gateway-boot.ts \
 *   --base /absolute/built-base --candidate /absolute/built-candidate \
 *   --output "$PWD/.local/state-read-boots" --pairs 3
 *
 * Serial AB/BA/AB order; no forced GC. /readyz first success is readiness. The
 * native process maxRSS includes every isolate (KiB on Node, including macOS),
 * equivalent to Linux VmHWM; retain readiness and readiness+5s samples separately.
 * CPU is cumulative main-thread and process CPU since launch, not a percentage.
 * Worker counts are the measured build's existing cumulative lifecycle counters.
 * This boot proof complements, and does not replace, team-shape-stress.ts.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { runManagedCommand, terminateManagedChild } from "../lib/managed-child-process.mts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { TEAM_STRESS_PLUGIN_IDS } from "./team-shape-stress-fixture.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    output: { type: "string" },
    pairs: { type: "string", default: "3" },
    sessions: { type: "string", default: "10800" },
    "settle-ms": { type: "string", default: "5000" },
  },
});
assert(
  values.base && values.candidate && values.output,
  "--base, --candidate and --output are required",
);
const pairs = parseStrictIntegerOption({
  raw: values.pairs,
  label: "--pairs",
  min: 1,
  fallback: 3,
});
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "--sessions",
  min: 100,
  fallback: 10800,
});
const settleMs = parseStrictIntegerOption({
  raw: values["settle-ms"],
  label: "--settle-ms",
  min: 0,
  fallback: 5000,
});
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output, { mode: 0o700 });
const builds = Object.fromEntries(
  Object.entries({ base: values.base, candidate: values.candidate }).map(([label, directory]) => {
    const buildRoot = realpathSync(directory);
    const entry = path.join(buildRoot, "dist/entry.js");
    return [
      label,
      {
        root: buildRoot,
        entry,
        entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
        buildInfo: JSON.parse(readFileSync(path.join(buildRoot, "dist/build-info.json"), "utf8")),
        ownerModules: Object.fromEntries(
          readdirSync(path.join(buildRoot, "dist"))
            .filter((name) => /^openclaw-state-read-worker-[\w-]+\.mjs$/.test(name))
            .map((name) => [
              name,
              createHash("sha256")
                .update(readFileSync(path.join(buildRoot, "dist", name)))
                .digest("hex"),
            ]),
        ),
      },
    ];
  }),
);
const now = Date.now();
const aborted = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => aborted.abort(new Error(`Interrupted by ${signal}`)));
}

async function freePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (address.port >= 40000) {
      return address.port;
    }
  }
  throw new Error("No free loopback port >=40000");
}

type Snapshot = {
  maxRssKiB: number;
  rssBytes: number;
  heapUsedBytes: number;
  mainCpuMs: number;
  totalCpuMs: number;
  workers: unknown;
};
async function sample(child: ChildProcess, id: string): Promise<Snapshot> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Boot telemetry timed out"));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", receive);
    };
    const receive = (message: unknown) => {
      const reply = message as {
        channel?: string;
        id?: string;
        error?: string;
        snapshot?: Snapshot;
      };
      if (reply?.channel !== "state-read-gateway-boot" || reply.id !== id) {
        return;
      }
      cleanup();
      if (reply.error || !reply.snapshot) {
        reject(new Error(reply.error ?? "Missing snapshot"));
      } else {
        resolve(reply.snapshot);
      }
    };
    child.on("message", receive);
    child.send({ channel: "state-read-gateway-boot", id }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

const results: unknown[] = [];
for (let pair = 0; pair < pairs; pair++) {
  for (const side of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
    aborted.signal.throwIfAborted();
    const build = builds[side]!;
    const directory = path.join(output, `${pair + 1}-${side}`);
    mkdirSync(directory);
    const state = path.join(directory, "state");
    const fixtureLog = openSync(path.join(directory, "fixture.log"), "wx", 0o600);
    const port = await freePort();
    try {
      const code = await runManagedCommand({
        bin: process.execPath,
        args: [
          "--import",
          "./scripts/tsx.mjs",
          "scripts/perf/team-shape-stress.ts",
          "--fixture-only",
          "--output",
          state,
          "--port",
          String(port),
          "--now",
          String(now),
          "--sessions",
          String(sessions),
          "--transcript-mib",
          "16",
        ],
        cwd: root,
        stdio: ["ignore", fixtureLog, fixtureLog],
      });
      assert.equal(code, 0, `Fixture failed: ${directory}`);
    } finally {
      closeSync(fixtureLog);
    }
    aborted.signal.throwIfAborted();
    const configPath = path.join(state, "openclaw.json");
    const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    config.plugins = {
      ...config.plugins,
      enabled: true,
      allow: [...TEAM_STRESS_PLUGIN_IDS],
      entries: Object.fromEntries(TEAM_STRESS_PLUGIN_IDS.map((id) => [id, { enabled: true }])),
    };
    config.diagnostics = { ...config.diagnostics, enabled: true };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const temporary = path.join(state, "tmp");
    mkdirSync(temporary, { recursive: true });
    const log = openSync(path.join(directory, "gateway.log"), "wx", 0o600);
    const loadBefore = loadavg();
    const started = performance.now();
    const child = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(build.entry, port, [
        "--import",
        fileURLToPath(new URL("./state-read-gateway-boot-preload.mjs", import.meta.url)),
      ]),
      {
        cwd: build.root,
        detached: true,
        env: createGatewayBenchEnv(state, configPath, {
          caseEnv: { OPENCLAW_STATE_DIR: state, TMPDIR: temporary },
        }),
        stdio: ["ignore", log, log, "ipc"],
      },
    );
    const stopped = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    try {
      const probe = await waitForInitialProbe({
        deadlineAt: started + 180_000,
        startAt: started,
        path: "/readyz",
        port,
        isDone: () =>
          child.exitCode !== null ||
          child.signalCode !== null ||
          Boolean(failure) ||
          aborted.signal.aborted,
      });
      if (failure) {
        throw failure;
      }
      aborted.signal.throwIfAborted();
      assert.equal(probe.status, 200, `Gateway did not become ready: ${directory}`);
      const ready = await sample(child, "ready");
      await delay(settleMs, undefined, { signal: aborted.signal });
      const settled = await sample(child, "settled");
      const result = {
        pair: pair + 1,
        side,
        build,
        port,
        readinessMs: probe.ms,
        probe,
        ready,
        settled,
        loadBefore,
        loadAfter: loadavg(),
      };
      results.push(result);
      writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
      writeFileSync(
        path.join(output, "comparison.json"),
        JSON.stringify(
          { pairs, sessions, plugins: TEAM_STRESS_PLUGIN_IDS.length, settleMs, now, results },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          pair: pair + 1,
          side,
          readinessMs: probe.ms,
          readyMaxRssMiB: ready.maxRssKiB / 1024,
          settledMaxRssMiB: settled.maxRssKiB / 1024,
          loadBefore,
          loadAfter: loadavg(),
        }),
      );
    } finally {
      terminateManagedChild(child);
      const forced = setTimeout(() => terminateManagedChild(child, "SIGKILL"), 10_000);
      try {
        await stopped;
      } finally {
        clearTimeout(forced);
        terminateManagedChild(child, "SIGKILL");
        closeSync(log);
      }
    }
  }
}
