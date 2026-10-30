/** Offline synthetic backlog, then unmodified chat.history over a real Gateway socket. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import type { TranscriptEvent } from "../src/config/sessions/session-accessor.sqlite-contract.ts";
import type { OpenClawConfig } from "../src/config/types.openclaw.ts";
import type { OperatorScope } from "../src/gateway/operator-scopes.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../src/infra/ed25519-signature.ts";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  summarizeNumbers,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "./lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    sessions: { type: "string", default: "6" },
    messages: { type: "string", default: "5000" },
    "payload-bytes": { type: "string", default: "256" },
    "target-index": { type: "string", default: "2" },
    "warm-samples": { type: "string", default: "5" },
    "counts-only": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    "seed-only": { type: "boolean", default: false },
  },
});
assert(values.out, "--out must name a new synthetic output directory");
assert(values.observer, "--observer must name the frozen observer.cjs");
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const sessions = integer(values.sessions, "--sessions", 2);
const messages = integer(values.messages, "--messages");
const payloadBytes = integer(values["payload-bytes"], "--payload-bytes");
const targetIndex = integer(values["target-index"], "--target-index", 0);
const warmSamples = integer(values["warm-samples"], "--warm-samples", 5);
assert(targetIndex < sessions, "--target-index must be below --sessions");
const output = path.resolve(values.out);
const fixture = path.join(output, "fixture");
const seedFile = path.join(output, "fixture.json");
const script = fileURLToPath(import.meta.url);
const sessionId = (index: number) => `projection-${String(index).padStart(4, "0")}`;
const sessionKey = (index: number) => `agent:main:${sessionId(index)}`;

async function seed() {
  // This subprocess owns a new, offline state directory. No live Gateway exists yet.
  const { setRuntimeConfigSnapshot } = await import("../src/config/runtime-snapshot.js");
  const { upsertSessionEntryCore, resolveSessionTranscriptDatabasePath } =
    await import("../src/config/sessions/session-accessor.js");
  const { replaceTranscriptEvents } =
    await import("../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js");
  const { waitForSessionTranscriptIndexReconcile } =
    await import("../src/config/sessions/session-transcript-reconcile.js");
  const { markSessionTranscriptIndexDirtyInTransaction } =
    await import("../src/config/sessions/session-transcript-index.js");
  const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
    await import("../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../src/state/openclaw-state-db.js");
  setRuntimeConfigSnapshot(JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8")));
  const storePath = path.join(fixture, "state", "agents", "main", "sessions", "sessions.json");
  let databasePath = "";
  try {
    for (let index = 0; index < sessions; index++) {
      const scope = {
        agentId: "main",
        sessionId: sessionId(index),
        sessionKey: sessionKey(index),
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
      const events: TranscriptEvent[] = [{ type: "session", version: 3, id: scope.sessionId }];
      for (let message = 0; message < messages; message++) {
        events.push({
          type: "message",
          id: `message-${message}`,
          parentId: message === 0 ? null : `message-${message - 1}`,
          message: {
            role: message % 2 ? "assistant" : "user",
            content: `Synthetic projection message ${message} ${"x".repeat(payloadBytes)}`,
          },
        });
      }
      await replaceTranscriptEvents(scope, events);
      await waitForSessionTranscriptIndexReconcile({ agentId: "main" });
      databasePath = resolveSessionTranscriptDatabasePath(scope);
    }
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < sessions; index++) {
          markSessionTranscriptIndexDirtyInTransaction(database.db, sessionId(index));
        }
      },
      { agentId: "main", path: databasePath },
    );
    writeFileSync(seedFile, JSON.stringify({ databasePath, sessions, messages, payloadBytes }));
  } finally {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  }
}

if (values["seed-only"]) {
  await seed();
} else {
  // Exclusive output creation prevents accidentally borrowing an existing/live state directory.
  mkdirSync(output);
  mkdirSync(path.join(fixture, "workspace"), { recursive: true });
  const config: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
  config.agents = { defaults: { skipBootstrap: true } };
  const origin = "https://projection-measure.example.invalid";
  const scopes: OperatorScope[] = ["operator.read", "operator.admin"];
  const identityName = "projection-measure";
  config.gateway = {
    ...config.gateway,
    trustedProxies: ["127.0.0.1"],
    controlUi: { enabled: false, allowedOrigins: [origin] },
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        allowLoopback: true,
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: [identityName],
        deviceAutoApprove: { enabled: true, scopes },
      },
      identityScopes: { [identityName]: scopes },
    },
    roles: {
      default: "administrator",
      definitions: {
        administrator: { agents: "*", sessions: { others: "view" }, scopes },
      },
    },
  };
  const configPath = writeGatewayBenchConfig(fixture, config, {
    agentList: [{ id: "main", workspace: path.join(fixture, "workspace") }],
  });
  const environment = createGatewayBenchEnv(fixture, configPath, {
    caseEnv: { OPENCLAW_SKIP_CHANNELS: "1", NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  const childArgs = [
    "--import",
    "./scripts/tsx.mjs",
    script,
    ...process.argv.slice(2),
    "--seed-only",
  ];
  const seedLog = createWriteStream(path.join(output, "seed.log"));
  const seeder = spawn(process.execPath, childArgs, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  seeder.stdout?.pipe(seedLog);
  seeder.stderr?.pipe(seedLog);
  await new Promise<void>((resolve, reject) => {
    seeder.once("error", reject);
    seeder.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Fixture seed failed (${code ?? signal})`)),
    );
  });
  const seeded: unknown = JSON.parse(readFileSync(seedFile, "utf8"));
  assert(isRecord(seeded) && typeof seeded.databasePath === "string", "Invalid synthetic fixture");
  const databasePath = seeded.databasePath;
  // These read-only proof snapshots run outside the Gateway and the measured SQL stream.
  const pendingProjections = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM session_transcript_index_state WHERE needs_rebuild = 1",
        )
        .get();
      return Number(row?.count ?? 0);
    } finally {
      database.close();
    }
  };
  assert.equal(
    pendingProjections(),
    sessions,
    "Offline backlog must contain every synthetic session",
  );
  const samples: Array<{
    phase: string;
    outcome: "ok" | "rebuilding";
    elapsedMs?: number;
    pendingAfter: number;
  }> = [];
  const phases: Array<{ phase: string; start: number; end: number }> = [];
  const setPhase = (phase: string) => {
    const now = Date.now();
    const previous = phases.at(-1);
    if (previous) {
      previous.end = now;
    }
    phases.push({ phase, start: now, end: now });
    writeFileSync(path.join(output, "phase"), phase);
  };
  let gateway: ChildProcess | undefined;
  let client: ReturnType<typeof createGatewayWsClient> | undefined;
  let complete = false;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      client?.close();
      if (gateway) {
        await stopChild(gateway, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
      }
    })());
  const interrupt = () => void stop().finally(() => process.exit(130));
  const terminate = () => void stop().finally(() => process.exit(143));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    setPhase("boot");
    const port = await getFreePort();
    const log = createWriteStream(path.join(output, "gateway.log"));
    gateway = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(
        values.entry,
        port,
        [...(values["cpu-profile"] ? gatewayBenchCpuProfileArgs(output) : [])],
        "trusted-proxy",
      ),
      {
        env: {
          ...environment,
          NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(values.observer))} --enable-source-maps`,
          SQLMEASURE_OUT: output,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      },
    );
    gateway.stdout?.pipe(log);
    gateway.stderr?.pipe(log);
    const ready = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: performance.now(),
      deadlineAt: performance.now() + 180_000,
      isDone: () => gateway?.exitCode !== null || gateway?.signalCode !== null,
    });
    assert.equal(ready.status, 200, "Gateway failed to become ready; inspect gateway.log");
    const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
    client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin,
      headers: {
        "x-forwarded-for": "192.0.2.1",
        "x-forwarded-proto": "https",
        "x-forwarded-user": identityName,
      },
      onEvent(event) {
        if (
          event.event === "connect.challenge" &&
          isRecord(event.payload) &&
          typeof event.payload.nonce === "string" &&
          typeof event.payload.ts === "number"
        ) {
          challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
        }
      },
    });
    await client.waitOpen();
    const timeout = setTimeout(
      () => challenge.reject(new Error("Device challenge timed out")),
      12_000,
    );
    const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timeout));
    const identity = {
      id: "openclaw-control-ui",
      version: "1.0.0",
      platform: process.platform,
      mode: "ui",
    };
    const keys = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const device = {
      id: deviceId,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        buildDeviceAuthPayloadV3({
          deviceId,
          clientId: identity.id,
          clientMode: identity.mode,
          platform: identity.platform,
          role: "operator",
          scopes,
          signedAtMs: ts,
          nonce,
        }),
      ),
    };
    const connected = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: identity,
      role: "operator",
      scopes,
      device,
      caps: [],
    });
    assert(connected.ok, "Synthetic Gateway handshake failed");
    assert(isRecord(connected.payload) && isRecord(connected.payload.auth));
    assert.equal(connected.payload.auth.method, "trusted-proxy");
    assert(Array.isArray(connected.payload.auth.scopes));
    for (const scope of scopes) {
      assert(connected.payload.auth.scopes.includes(scope), `Gateway did not grant ${scope}`);
    }
    const readHistory = async (phase: string) => {
      setPhase(phase);
      const started = values["counts-only"] ? undefined : performance.now();
      const response = await client!.request(
        "chat.history",
        { sessionKey: sessionKey(targetIndex), limit: 1, maxChars: 1024 },
        30_000,
      );
      const timing = started === undefined ? {} : { elapsedMs: performance.now() - started };
      if (!response.ok) {
        const error = response.error;
        assert(
          phase === "cold-read" &&
            isRecord(error) &&
            error.code === "UNAVAILABLE" &&
            error.message === "session history is rebuilding; retry shortly" &&
            error.retryable === true &&
            error.retryAfterMs === 250 &&
            isRecord(error.details) &&
            error.details.method === "chat.history",
          `Unexpected chat.history failure in ${phase}; inspect gateway.log`,
        );
        samples.push({
          phase,
          outcome: "rebuilding",
          ...timing,
          pendingAfter: pendingProjections(),
        });
        return;
      }
      assert(isRecord(response.payload) && Array.isArray(response.payload.messages));
      assert(
        response.payload.sessionKey === sessionKey(targetIndex),
        "Unexpected history session key",
      );
      assert(
        response.payload.sessionId === sessionId(targetIndex),
        "Unexpected history session ID",
      );
      assert.equal(response.payload.messages.length, 1, "Expected one synthetic history message");
      const message = response.payload.messages[0];
      assert(isRecord(message), "Expected a synthetic history message object");
      assert(
        message.role === ((messages - 1) % 2 ? "assistant" : "user"),
        "Unexpected message role",
      );
      assert(
        message.content ===
          `Synthetic projection message ${messages - 1} ${"x".repeat(payloadBytes)}`,
        "Expected the latest synthetic history message",
      );
      samples.push({ phase, outcome: "ok", ...timing, pendingAfter: pendingProjections() });
    };
    await readHistory("cold-read");
    setPhase("drain");
    const deadline = Date.now() + 120_000;
    while (pendingProjections() > 0) {
      assert(Date.now() < deadline, "Synthetic projections did not finish");
      await delay(100);
    }
    for (let index = 0; index < warmSamples; index++) {
      await readHistory(`warm-read-${index}`);
    }
    complete = true;
  } finally {
    setPhase("shutdown");
    await stop();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    setPhase("done");
    const requestCounts: Record<string, { requests: number; projectionRequests: number }> = {};
    for (const filename of readdirSync(output).filter((name) => /^sql-.*\.jsonl$/u.test(name))) {
      for (const line of readFileSync(path.join(output, filename), "utf8").split("\n")) {
        if (!line) {
          continue;
        }
        const row: unknown = JSON.parse(line);
        if (isRecord(row) && row.type === "request") {
          const count = (requestCounts[String(row.phase)] ??= {
            requests: 0,
            projectionRequests: 0,
          });
          count.requests++;
          // Frozen causality.cjs passes { cause, operation, nativeId } to observer.onRequest.
          if (
            isRecord(row.cause) &&
            Array.isArray(row.cause.payloadDiscriminators) &&
            row.cause.payloadDiscriminators.some(
              (pair: unknown) => Array.isArray(pair) && pair[1] === "projection-status",
            )
          ) {
            count.projectionRequests++;
          }
        }
      }
    }
    const coldSample = samples.find((sample) => sample.phase === "cold-read");
    const warmReadSamples = samples.filter(
      (sample) => sample.phase.startsWith("warm-read-") && sample.outcome === "ok",
    );
    const evidence = {
      complete,
      children: gateway?.pid ? [{ name: "gateway", pid: gateway.pid }] : [],
      turns: [],
      harnessVersion: "3.1.4",
      countsOnly: values["counts-only"],
      workload: { sessions, messages, payloadBytes, targetIndex, warmSamples },
      reproduced: (requestCounts["cold-read"]?.projectionRequests ?? 0) > 1,
      waitObserved: (requestCounts["cold-read"]?.projectionRequests ?? 0) > 0,
      coldOutcome: coldSample?.outcome,
      earlyReadiness: coldSample?.outcome === "ok" && coldSample.pendingAfter > 0,
      completedWarmReads: warmReadSamples.length,
      samples,
      ...(values["counts-only"]
        ? {}
        : { warmLatencyMs: summarizeNumbers(warmReadSamples.map((sample) => sample.elapsedMs!)) }),
      requestCounts,
      phases,
      caveat:
        "The polling defect is reproduced only with more than one cold-read projection-status request. One request proves entry but not repeated polling. Only the exact cold projection-rebuilding response is accepted before draining; warm reads must succeed. No timing delay, fake RPC, or production branch was injected. pendingAfter and drain polling use external read-only snapshots of this synthetic fixture, outside Gateway counts.",
    };
    writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
    if (gateway?.pid) {
      // Reuse the frozen successful-execution and multi-statement accounting verbatim.
      const result = await promisify(execFile)("python3", [
        path.join(path.dirname(path.resolve(values.observer)), "analyze.py"),
        output,
      ]);
      writeFileSync(path.join(output, "analysis.log"), result.stdout + result.stderr);
    }
    console.log(JSON.stringify(evidence));
  }
}
