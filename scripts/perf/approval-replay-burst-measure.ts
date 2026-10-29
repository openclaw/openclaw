/**
 * Real, isolated Gateway approval replay after a 40-socket reconnect burst.
 * Build both revisions first; never point this at operator state or a live Gateway.
 * node --import ./scripts/tsx.mjs scripts/perf/approval-replay-burst-measure.ts \
 *   --base-entry .local/base/dist/entry.js --candidate-entry dist/entry.js \
 *   --output .local/approval-replay-comparison
 * Allocation-only pass (sampled main-thread bytes, no timing/CPU conclusions):
 * node --import ./scripts/tsx.mjs scripts/perf/approval-replay-burst-measure.ts \
 *   --base-entry .local/base/dist/entry.js --candidate-entry dist/entry.js \
 *   --output .local/approval-replay-allocation --allocation --pairs 1 --waves 25
 *
 * Defaults: 10k sessions, 10k live approvals over 1k audiences, 40 sockets,
 * 25 reconnect waves per case (1k samples), five serial AB/BA pairs. The first
 * burst for each case is reported separately; subsequent bursts are warm.
 * Approvals are registered through the running Gateway, so startup recovery
 * cannot erase an offline fixture. No command is approved or executed.
 * Acceptance: exact ordered approval IDs/payloads and zero errors; pending work
 * scales with the selected audience, one prepared replay per same-scope burst;
 * compare paired client and server p50/p99 with host load, never an isolated max.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "base-entry": { type: "string" },
    "candidate-entry": { type: "string" },
    output: { type: "string" },
    allocation: { type: "boolean", default: false },
    port: { type: "string", default: "41470" },
    sessions: { type: "string", default: "10000" },
    approvals: { type: "string", default: "10000" },
    audiences: { type: "string", default: "1000" },
    clients: { type: "string", default: "40" },
    waves: { type: "string", default: "25" },
    pairs: { type: "string", default: "5" },
  },
});
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
if (!values["base-entry"] || !values["candidate-entry"] || !values.output) {
  throw new Error("--base-entry, --candidate-entry and --output are required");
}
const root = path.resolve(values.output);
const port = integer(values.port, "--port", 40000);
const sessions = integer(values.sessions, "--sessions");
const approvals = integer(values.approvals, "--approvals");
const audiences = integer(values.audiences, "--audiences");
const clientCount = integer(values.clients, "--clients");
const waves = integer(values.waves, "--waves");
const pairs = integer(values.pairs, "--pairs");
assert(port < 65535 && audiences <= sessions && audiences > clientCount);
assert(approvals >= audiences && Math.ceil(approvals / audiences) <= 1000);
mkdirSync(root, { mode: 0o700 });
const token = "synthetic-approval-replay-burst-token";
const sessionKey = (index: number) => `agent:main:team-shape-session-${index}`;
const approvalId = (index: number) => `synthetic-approval-${String(index).padStart(8, "0")}`;
const command = (index: number) => `printf synthetic-approval-${index}`;
const devices = Array.from({ length: clientCount + 1 }, () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  return {
    id: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
    publicKey,
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
});
type Client = ReturnType<typeof createGatewayWsClient>;
type ExpectedApproval = { id: string; createdAtMs: number; expiresAtMs: number; command: string };
type Arm = {
  name: string;
  entry: string;
  port: number;
  stateDir: string;
  child: ChildProcess;
  clients: Set<Client>;
  expected: Map<string, ExpectedApproval[]>;
  seedClient?: Client;
  diagnostics: (action: "start" | "stop") => Promise<Record<string, unknown>>;
};
const arms: Arm[] = [];
const samples: Array<Record<string, unknown>> = [];
function stats(valuesMs: number[]) {
  assert(valuesMs.length > 0);
  const sorted = valuesMs.toSorted((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    count: valuesMs.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}
async function rpc(client: Client, method: string, params: unknown) {
  const reply = await client.request(method, params, 120_000);
  assert(reply.ok, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.payload;
}
async function connect(arm: Arm, index: number): Promise<Client> {
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${arm.port}`,
    handshakeTimeoutMs: 30_000,
    openTimeoutMs: 30_000,
    onEvent: (event) => {
      const value = event.payload;
      if (
        event.event === "connect.challenge" &&
        isRecord(value) &&
        typeof value.nonce === "string" &&
        typeof value.ts === "number"
      ) {
        challenge.resolve({ nonce: value.nonce, ts: value.ts });
      }
    },
  });
  arm.clients.add(client);
  try {
    await client.waitOpen();
    const timer = setTimeout(
      () => challenge.reject(new Error("Device challenge timed out")),
      30_000,
    );
    const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timer));
    const device = devices[index]!;
    const scopes = ["operator.admin", "operator.read", "operator.write"];
    const identity = {
      id: "gateway-client",
      mode: "ui",
      version: "1.0.0",
      platform: process.platform,
      instanceId: `approval-burst-${index}`,
    };
    const payload = buildDeviceAuthPayloadV3({
      deviceId: device.id,
      clientId: identity.id,
      clientMode: identity.mode,
      platform: identity.platform,
      role: "operator",
      scopes,
      signedAtMs: ts,
      token,
      nonce,
    });
    const hello = await rpc(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: identity,
      role: "operator",
      scopes,
      auth: { token },
      device: {
        id: device.id,
        publicKey: device.publicKey,
        signedAt: ts,
        nonce,
        signature: signEd25519Payload(device.privateKey, payload),
      },
      caps: [],
    });
    assert(
      isRecord(hello) &&
        isRecord(hello.auth) &&
        Array.isArray(hello.auth.scopes) &&
        hello.auth.scopes.includes("operator.admin"),
      "Missing admin scope on synthetic device",
    );
    return client;
  } catch (error) {
    client.close();
    arm.clients.delete(client);
    throw error;
  }
}
async function close(arm: Arm, clients: Client[]) {
  await Promise.all(
    clients.map(
      (client) =>
        new Promise<void>((resolve) => {
          arm.clients.delete(client);
          if (client.ws.readyState === 3) {
            resolve();
            return;
          }
          client.ws.once("close", () => resolve());
          client.close();
        }),
    ),
  );
}
async function childCommand(args: string[], logFile: string, env?: NodeJS.ProcessEnv) {
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Fixture failed (${code}); see ${logFile}`)),
      );
    });
  } finally {
    log.end();
    await finished(log);
  }
}
async function start(name: string, entry: string, gatewayPort: number) {
  const stateDir = path.join(root, name);
  await childCommand(
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/perf/team-shape-fixture.ts",
      "--state-dir",
      stateDir,
      "--sessions",
      String(sessions),
      "--runs",
      "0",
      "--approvals",
      "0",
      "--cron",
      "0",
      "--projects",
      "0",
      "--transcript-mib",
      "0",
      "--port",
      String(gatewayPort),
      "--now",
      String(Date.now()),
    ],
    path.join(root, `${name}-fixture.log`),
  );
  const configPath = path.join(stateDir, "openclaw.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.gateway.auth = { mode: "token", token };
  config.session = { maintenance: { maxEntries: sessions * 2, mode: "warn" } };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const env = {
    ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_SKIP_CHANNELS: "1",
    TMPDIR: path.join(stateDir, "tmp"),
    OPENCLAW_PROFILE: `approval-burst-${gatewayPort}`,
  };
  const log = createWriteStream(path.join(root, `${name}-gateway.log`));
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(
      path.resolve(entry),
      gatewayPort,
      ["--import", fileURLToPath(new URL("./approval-replay-burst-probe.mjs", import.meta.url))],
      "token",
    ),
    {
      env,
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  child.once("close", () => log.end());
  const arm: Arm = {
    name,
    entry,
    port: gatewayPort,
    stateDir,
    child,
    clients: new Set(),
    expected: new Map(),
    diagnostics: (action) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Probe timed out")), 10_000);
        child.once("message", (message) => {
          clearTimeout(timer);
          if (!isRecord(message) || message.error) {
            reject(new Error(`Probe failed: ${JSON.stringify(message)}`));
          } else {
            resolve(message);
          }
        });
        child.send({ approvalBurst: action, allocation: values.allocation });
      }),
  };
  arms.push(arm);
  const deadline = performance.now() + 180_000;
  for (;;) {
    assert(
      child.exitCode === null && child.signalCode === null,
      `${name} Gateway exited; inspect log`,
    );
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        break;
      }
    } catch {
      /* Owned Gateway admission has not finished. */
    }
    assert(performance.now() < deadline, `${name} Gateway readiness timed out`);
    await delay(100);
  }
  // Pair sequentially once, outside measurement; reconnects reuse these identities.
  for (let i = 0; i < clientCount; i++) {
    await close(arm, [await connect(arm, i)]);
  }
  arm.seedClient = await connect(arm, clientCount);
  const seedStarted = performance.now();
  for (let offset = 0; offset < approvals; offset += 16) {
    await Promise.all(
      Array.from({ length: Math.min(16, approvals - offset) }, async (_, n) => {
        const index = offset + n;
        const key = sessionKey(index % audiences);
        const accepted = await rpc(arm.seedClient!, "exec.approval.request", {
          id: approvalId(index),
          command: command(index),
          host: "gateway",
          agentId: "main",
          sessionKey: key,
          twoPhase: true,
          suppressDelivery: true,
          requireDeliveryRoute: false,
          timeoutMs: 86_400_000,
        });
        assert(
          isRecord(accepted) &&
            accepted.status === "accepted" &&
            accepted.id === approvalId(index) &&
            typeof accepted.createdAtMs === "number" &&
            typeof accepted.expiresAtMs === "number",
          "Approval was not retained",
        );
        const row = {
          id: approvalId(index),
          createdAtMs: accepted.createdAtMs,
          expiresAtMs: accepted.expiresAtMs,
          command: command(index),
        };
        const list = arm.expected.get(key) ?? [];
        list.push(row);
        arm.expected.set(key, list);
      }),
    );
    if (offset % 1000 < 16) {
      console.log(
        JSON.stringify({ phase: "seed", arm: name, approvals: Math.min(offset + 16, approvals) }),
      );
    }
  }
  for (const list of arm.expected.values()) {
    list.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
  }
  console.log(
    JSON.stringify({
      phase: "ready",
      arm: name,
      approvals,
      sessions,
      seedMs: performance.now() - seedStarted,
    }),
  );
  return arm;
}
const reference = new Map<string, unknown>();
async function burst(arm: Arm, scenario: "same" | "distinct", pair: number, wave: number) {
  const connected = await Promise.all(
    Array.from({ length: clientCount }, (_, i) => connect(arm, i)),
  );
  await arm.diagnostics("start");
  const load = os.loadavg();
  const started = performance.now();
  try {
    const durationMs = await Promise.all(
      connected.map(async (client, index) => {
        const key = sessionKey(scenario === "same" ? audiences - 1 : index);
        const requestStarted = performance.now();
        const response = await rpc(client, "sessions.messages.subscribe", {
          key,
          includeApprovals: true,
        });
        const ms = performance.now() - requestStarted;
        assert(
          isRecord(response) && response.subscribed === true && isRecord(response.approvalReplay),
          "Missing approval replay",
        );
        const replay = response.approvalReplay;
        assert.equal(replay.sessionKey, key);
        assert.equal(replay.truncated, false);
        assert(Array.isArray(replay.approvals));
        const expected = arm.expected.get(key)!;
        assert.deepEqual(
          replay.approvals.map((item) => (isRecord(item) ? item.id : null)),
          expected.map((item) => item.id),
        );
        for (const [approvalIndex, item] of replay.approvals.entries()) {
          assert(isRecord(item) && isRecord(item.presentation));
          assert.equal(item.status, "pending");
          assert.equal(item.createdAtMs, expected[approvalIndex]!.createdAtMs);
          assert.equal(item.expiresAtMs, expected[approvalIndex]!.expiresAtMs);
          assert.equal(item.presentation.commandText, expected[approvalIndex]!.command);
          assert.equal(item.sourceSessionKey, key);
        }
        const normalized = replay.approvals.map((item) => {
          const { createdAtMs: _created, expiresAtMs: _expires, ...rest } = item;
          return rest;
        });
        if (!reference.has(key)) {
          reference.set(key, normalized);
        } else {
          assert.deepEqual(
            normalized,
            reference.get(key),
            "Replay payload differs across arms or reconnects",
          );
        }
        return ms;
      }),
    );
    const server = await arm.diagnostics("stop");
    assert(server.handlerCount === clientCount, "Missing server handler observations");
    const result = {
      mode: values.allocation ? "allocation" : "timing",
      server,
      arm: arm.name,
      scenario,
      pair,
      wave,
      cold: pair < 0,
      hostLoad: load,
      ...(values.allocation
        ? {}
        : {
            burstMs: performance.now() - started,
            clientMs: stats(durationMs),
            samplesMs: durationMs,
          }),
    };
    samples.push(result);
    console.log(JSON.stringify(result));
  } finally {
    await close(arm, connected);
  }
}
try {
  const base = await start("base", values["base-entry"], port);
  const candidate = await start("candidate", values["candidate-entry"], port + 1);
  for (const arm of [base, candidate]) {
    for (const scenario of ["same", "distinct"] as const) {
      await burst(arm, scenario, -1, 0);
    }
  }
  for (let pair = 0; pair < pairs; pair++) {
    for (const arm of pair % 2 === 0 ? [base, candidate] : [candidate, base]) {
      for (const scenario of ["same", "distinct"] as const) {
        for (let wave = 0; wave < waves; wave++) {
          await burst(arm, scenario, pair, wave);
        }
      }
    }
  }
  const summary = {
    mode: values.allocation ? "allocation" : "timing",
    node: process.version,
    sessions,
    approvals,
    audiences,
    clientCount,
    waves,
    pairs,
    arms: arms.map(({ name, entry }) => ({ name, entry })),
    samples,
  };
  writeFileSync(path.join(root, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ phase: "complete", output: path.join(root, "results.json") }));
} finally {
  for (const arm of arms) {
    await close(arm, [...arm.clients]);
    await stopChild(arm.child);
  }
}
