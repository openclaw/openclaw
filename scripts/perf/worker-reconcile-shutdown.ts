/**
 * Real dist-Gateway shutdown/restart proof with one synthetic worker-provider lease.
 * Build both revisions first, then run this tooling script separately for each:
 * node --import ./scripts/tsx.mjs scripts/perf/worker-reconcile-shutdown.ts \
 *   --root /path/to/built-revision --output "$PWD/.local/reconcile-candidate"
 * Add --expect-timeout for the unchanged baseline. All listeners are loopback >=40000;
 * only owned child processes and freshly generated state are used. The fixture hangs
 * destroy until its AbortSignal fires, retaining the same lease for the next boot.
 * For inspection retry backoff, add --reconcile-minutes 8 on both revisions and
 * --expect-backoff on the candidate. Inspection hangs until its real 15s timeout;
 * baseline must attempt >=7 times, candidate 2–4 times, then restart retries promptly.
 * This proves process shutdown and durable teardown replay, not pending reply delivery
 * or the separate ten-minute Team-shaped load-test requirement.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    output: { type: "string" },
    "expect-timeout": { type: "boolean", default: false },
    "expect-backoff": { type: "boolean", default: false },
    "reconcile-minutes": { type: "string" },
    "stop-budget-ms": { type: "string", default: "20000" },
    "startup-budget-ms": { type: "string", default: "120000" },
    fixture: { type: "string" },
  },
});
assert(values.output, "--output must name a new directory");
const output = path.resolve(values.output);
const root = path.resolve(values.root);
const stateDir = path.join(output, "state");
const providerId = "reconcile-shutdown-fixture";
const environmentId = "worker:reconcile-shutdown-fixture";
const leaseId = "synthetic-shutdown-lease";
const budget = (raw: string) => {
  const parsed = Number(raw);
  assert(Number.isSafeInteger(parsed) && parsed > 0, "Budgets must be positive integers");
  return parsed;
};
const stopBudgetMs = budget(values["stop-budget-ms"]);
const startupBudgetMs = budget(values["startup-budget-ms"]);
const reconcileMinutes = values["reconcile-minutes"] ? budget(values["reconcile-minutes"]) : 0;
assert(!reconcileMinutes || reconcileMinutes >= 8, "Reconcile observation must last >=8 minutes");
assert(!values["expect-backoff"] || reconcileMinutes, "--expect-backoff needs --reconcile-minutes");
assert(!reconcileMinutes || !values["expect-timeout"], "Inspection mode expects clean shutdown");
const script = fileURLToPath(import.meta.url);
const toolingRoot = fileURLToPath(new URL("../../", import.meta.url));

async function fixture(mode: string) {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(output, "openclaw.json");
  const state = await import("../../src/state/openclaw-state-db.js");
  const { createWorkerEnvironmentStore } =
    await import("../../src/gateway/worker-environments/store.js");
  const database = state.openOpenClawStateDatabase();
  const store = await createWorkerEnvironmentStore({ database });
  try {
    if (mode === "seed") {
      await store.createIntent({
        environmentId,
        providerId,
        profileId: "synthetic",
        profileSnapshot: { settings: {}, executionMode: "remote-exec" },
        provisionOperationId: "synthetic-shutdown-operation",
      });
      await store.transition({ environmentId, from: "requested", to: "provisioning" });
      await store.requestDestroy({ environmentId, state: "provisioning" });
      await store.transition({
        environmentId,
        from: "provisioning",
        to: "draining",
        patch: {
          leaseId,
          sharedHost: false,
          sshEndpoint: {
            host: "worker.example.test",
            port: 22,
            user: "synthetic",
            hostKey: "ssh-ed25519 AAAA",
            keyRef: { source: "file", provider: "worker-keys", id: "/synthetic/key" },
          },
        },
      });
      await store.transition({ environmentId, from: "draining", to: "destroying" });
    }
    const record = store.get(environmentId);
    assert(record, "Synthetic environment was not retained");
    writeFileSync(path.join(output, `${mode}.json`), JSON.stringify(record, null, 2));
  } finally {
    await store.close();
    await state.closeOpenClawStateDatabaseAsync();
    await (await import("../../src/logging/logger.js")).flushLogger();
  }
}

async function runFixture(mode: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(toolingRoot, "scripts/tsx.mjs"),
      script,
      "--root",
      root,
      "--output",
      output,
      "--fixture",
      mode,
    ],
    { cwd: toolingRoot, stdio: ["ignore", "inherit", "inherit"] },
  );
  const result = await exitOf(child);
  assert.equal(result.code, 0, `Fixture ${mode} failed`);
  return JSON.parse(readFileSync(path.join(output, `${mode}.json`), "utf8"));
}

function exitOf(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function freePort() {
  for (;;) {
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
}

async function writePlugin() {
  const pluginDir = path.join(output, "plugins", providerId);
  await fs.mkdir(pluginDir, { recursive: true });
  writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: providerId,
      activation: { onStartup: true },
      contracts: { workerProviders: [providerId] },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `
const fs = require("node:fs");
const path = require("node:path");
const marker = (name) => fs.writeFileSync(path.join(${JSON.stringify(output)}, process.env.OPENCLAW_FIXTURE_PHASE + "-" + name), String(Date.now()));
module.exports = {
  id: ${JSON.stringify(providerId)},
  register(api) {
    api.registerWorkerProvider({
      id: ${JSON.stringify(providerId)},
      supportedExecutionModes: ["remote-exec"],
      resolveAllocation: async () => ({ leaseId: ${JSON.stringify(leaseId)}, sharedHost: false }),
      provision: async () => { throw new Error("Fixture must never allocate a new lease"); },
      async inspect(lease) {
        if (!${Boolean(reconcileMinutes)}) return { status: "active" };
        if (lease.leaseId !== ${JSON.stringify(leaseId)}) throw new Error("Inspection changed the lease");
        const attempt = { startedAtMs: Date.now(), leaseId: lease.leaseId };
        const events = path.join(${JSON.stringify(output)}, process.env.OPENCLAW_FIXTURE_PHASE + "-inspect.jsonl");
        fs.appendFileSync(events, JSON.stringify(attempt) + "\\n");
        marker("inspect-entered");
        await new Promise((resolve, reject) => {
          const abort = () => {
            fs.appendFileSync(events, JSON.stringify({ ...attempt, abortedAtMs: Date.now(), reason: String(lease.signal.reason) }) + "\\n");
            reject(lease.signal.reason);
          };
          if (lease.signal.aborted) abort();
          else lease.signal.addEventListener("abort", abort, { once: true });
        });
      },
      resolveDestroyTimeoutMs: () => 600000,
      async destroy(lease) {
        if (lease.leaseId !== ${JSON.stringify(leaseId)}) throw new Error("Replay changed the lease");
        marker("destroy-entered");
        if (process.env.OPENCLAW_FIXTURE_PHASE === "restart") {
          marker("destroy-confirmed");
          return;
        }
        await new Promise((resolve, reject) => {
          const abort = () => { marker("destroy-aborted"); reject(lease.signal.reason); };
          if (lease.signal?.aborted) abort();
          else lease.signal?.addEventListener("abort", abort, { once: true });
        });
      }
    });
  }
};
`,
  );
  return { pluginIds: [providerId], pluginsDir: path.dirname(pluginDir) };
}

async function main() {
  const entry = path.join(root, "dist/entry.js");
  assert(existsSync(entry), "--root must have an already-built dist/entry.js");
  await fs.mkdir(output, { recursive: false });
  await fs.mkdir(path.join(output, "tmp"));
  await fs.mkdir(path.join(output, "workspace"));
  const pluginFixtures = await writePlugin();
  const port = await freePort();
  const configPath = writeGatewayBenchConfig(
    output,
    {
      ...BASE_GATEWAY_BENCH_CONFIG,
      cloudWorkers: { profiles: { synthetic: { provider: providerId, settings: {} } } },
      logging: { file: path.join(output, "runtime.log"), level: "info" },
    },
    { pluginFixtures, agentList: [{ id: "main", workspace: path.join(output, "workspace") }] },
  );
  await runFixture("seed");
  const arms = [];
  for (const phase of ["initial", "restart"]) {
    const log = await fs.open(path.join(output, `${phase}.log`), "wx", 0o600);
    const child = spawn(process.execPath, buildGatewayBenchChildArgs(entry, port), {
      cwd: root,
      env: createGatewayBenchEnv(output, configPath, {
        restartTrace: true,
        caseEnv: { OPENCLAW_FIXTURE_PHASE: phase, TMPDIR: path.join(output, "tmp") },
      }),
      stdio: ["ignore", log.fd, log.fd],
    });
    const exited = exitOf(child);
    let done = false;
    void exited.then(() => {
      done = true;
    });
    try {
      const marker = path.join(
        output,
        reconcileMinutes
          ? `${phase}-inspect-entered`
          : `${phase}-destroy-${phase === "initial" ? "entered" : "confirmed"}`,
      );
      const deadline = performance.now() + startupBudgetMs;
      const waitForProvider = async (until: number) => {
        while (!existsSync(marker)) {
          assert(!done, `${phase} Gateway exited before reaching provider; see ${phase}.log`);
          assert(
            performance.now() < until,
            `${phase} Gateway never reached provider; see ${phase}.log`,
          );
          await delay(100);
        }
      };
      if (!reconcileMinutes) {
        await waitForProvider(deadline);
      }
      // Startup reconciliation runs after readiness. Wait for the real endpoint before SIGTERM.
      while (true) {
        assert(!done && performance.now() < deadline, `${phase} Gateway did not become ready`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (response.ok) {
            break;
          }
        } catch {
          /* Startup listener may not be accepting connections yet. */
        }
        await delay(100);
      }
      const readyAtMs = Date.now();
      const observationStarted = performance.now();
      if (reconcileMinutes) {
        await waitForProvider(Math.min(deadline, observationStarted + 15_000));
        if (phase === "initial") {
          while (performance.now() - observationStarted < reconcileMinutes * 60_000) {
            assert(!done, "Gateway exited during reconcile observation");
            await delay(1_000);
          }
        }
      }
      const observationMs = performance.now() - observationStarted;
      const started = performance.now();
      child.kill("SIGTERM");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        exited,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), stopBudgetMs);
        }),
      ]).finally(() => clearTimeout(timeout));
      const elapsedMs = performance.now() - started;
      const killed = result === null;
      if (killed) {
        child.kill("SIGKILL");
      }
      const exit = result ?? (await exited);
      const inspectionEvents: { startedAtMs: number; abortedAtMs?: number; reason?: string }[] =
        reconcileMinutes
          ? readFileSync(path.join(output, `${phase}-inspect.jsonl`), "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
      const attempts = inspectionEvents.filter((event) => event.abortedAtMs === undefined);
      arms.push({
        phase,
        elapsedMs,
        killed,
        ...exit,
        aborted: existsSync(path.join(output, `${phase}-destroy-aborted`)),
        ...(reconcileMinutes ? { readyAtMs, observationMs, attempts, inspectionEvents } : {}),
      });
      const record = await runFixture(phase === "initial" ? "interrupted" : "recovered");
      if (reconcileMinutes) {
        assert.equal(killed, false, "Inspection shutdown exceeded its budget");
        assert.equal(exit.code, 0, "Inspection shutdown did not exit cleanly");
        assert.equal(record.state, "destroying", "Inspection failure must retain teardown intent");
        assert.equal(record.leaseId, leaseId);
        assert(record.lastError, "Inspection interruption must have a visible outcome");
        assert(
          !existsSync(path.join(output, `${phase}-destroy-entered`)),
          "Inspection reached destroy",
        );
        if (phase === "initial") {
          assert(observationMs >= reconcileMinutes * 60_000);
          assert(
            attempts.length >= (values["expect-backoff"] ? 2 : 7),
            "Too few inspection attempts",
          );
          if (values["expect-backoff"]) {
            assert(attempts.length <= 4, "Backoff did not reduce retries");
          }
          assert(
            inspectionEvents.some((event) => event.reason?.includes("15s budget")),
            "No real inspection timeout observed",
          );
        } else {
          assert.equal(attempts.length, 1, "Restart must begin a new inspection");
          const firstAttempt = attempts[0];
          assert(firstAttempt, "Restart inspection was not recorded");
          assert(firstAttempt.startedAtMs - readyAtMs <= 15_000, "Restart inherited retry delay");
        }
      } else if (phase === "initial") {
        assert.equal(record.state, "destroying", "Interrupted teardown must remain retryable");
        assert.equal(record.leaseId, leaseId);
        assert.equal(
          killed,
          values["expect-timeout"],
          "Shutdown deadline outcome differed from expectation",
        );
        if (!killed) {
          assert.equal(exit.code, 0, "Candidate shutdown did not exit cleanly");
          assert(
            existsSync(path.join(output, "initial-destroy-aborted")),
            "Shutdown did not abort destroy",
          );
          assert.match(
            record.lastError ?? "",
            /paused|interrupt|aborted/i,
            "Interruption was not recorded",
          );
        }
      } else {
        assert.equal(record.state, "destroyed", "Restart did not complete retained teardown");
        assert.equal(killed, false, "Restart cleanup exceeded its budget");
        assert.equal(exit.code, 0, "Restart shutdown did not exit cleanly");
      }
    } finally {
      if (!done) {
        child.kill("SIGKILL");
      }
      await exited;
      await log.close();
    }
  }
  const result = {
    root,
    entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
    port,
    stopBudgetMs,
    expectTimeout: values["expect-timeout"],
    ...(reconcileMinutes ? { reconcileMinutes, expectBackoff: values["expect-backoff"] } : {}),
    arms,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

try {
  if (values.fixture) {
    assert(["seed", "interrupted", "recovered"].includes(values.fixture), "Invalid fixture phase");
    await fixture(values.fixture);
  } else {
    await main();
  }
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
