/**
 * Real Gateway memory.search work counts, using synthetic keyword memory.
 * Build qaRuntime first. Run with node --import ./scripts/tsx.mjs <this file>.
 * Required: PGCENSUS_OUT (new directory), PGCENSUS_ENGINE (sqlite/postgres).
 * PostgreSQL also needs PGCENSUS_CONNECTION (a throwaway database).
 * Optional: PGCENSUS_EXPECT_COUNT_STATEMENTS enforces the per-search count budget.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import type { MemorySearchResponse } from "../../packages/memory-host-sdk/src/host/types.ts";
import { OpenClawSchema } from "../../src/config/zod-schema.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

type GatewayReply = Awaited<ReturnType<ReturnType<typeof createGatewayWsClient>["request"]>>;

const output = process.env.PGCENSUS_OUT;
const engine = process.env.PGCENSUS_ENGINE;
assert(
  output && (engine === "sqlite" || engine === "postgres"),
  "Set PGCENSUS_OUT and PGCENSUS_ENGINE",
);
assert(engine !== "postgres" || process.env.PGCENSUS_CONNECTION, "Set PGCENSUS_CONNECTION");
fs.mkdirSync(output, { recursive: false });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-search-status-"));
const samples: {
  startNs: string;
  endNs: string;
  wallMs: number;
  response: MemorySearchResponse;
}[] = [];
let gateway: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let challengeTimer: ReturnType<typeof setTimeout> | undefined;
try {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  const corpus = [
    ["aurora", "The Aurora observatory calibration code is CRIMSON-482."],
    ["cedar", "The Cedar greenhouse irrigation target is 42 liters each dawn."],
    ["harbor", "The Harbor robotics checkpoint is DELTA-731."],
    ["quartz", "The Quartz weather station reference temperature is 18 degrees Celsius."],
  ] as const;
  // Provenance exposes file mtime, so both revisions need identical input timestamps.
  const fixtureTime = new Date("2026-10-01T00:00:00.000Z");
  for (const [name, text] of corpus) {
    const file = path.join(workspace, "memory", `${name}.md`);
    fs.writeFileSync(file, text + "\n");
    fs.utimesSync(file, fixtureTime, fixtureTime);
  }
  const port = await getFreePort();
  const config = OpenClawSchema.parse({
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: {
      ownership: "explicit",
      defaults: { model: { primary: "openai/gpt-4.1-mini" }, skipBootstrap: true },
      entries: { main: { workspace } },
    },
    memory: {
      search: { provider: "none", sources: ["memory"], store: { vector: { enabled: false } } },
    },
    plugins: {
      enabled: true,
      entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
    },
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      port,
      auth: {
        mode: "trusted-proxy",
        identityScopes: { "census@example.test": ["operator.read"] },
        trustedProxy: {
          userHeader: "x-census-user",
          allowLoopback: true,
          allowUsers: ["census@example.test"],
          deviceAutoApprove: { enabled: true, scopes: ["operator.read"] },
        },
      },
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { enabled: false, allowedOrigins: ["http://census.example.test"] },
    },
    ...(engine === "postgres"
      ? {
          database: {
            engine,
            postgres: {
              connection: { source: "env", provider: "default", id: "PGCENSUS_CONNECTION" },
              schemaPrefix: "memorysearchstatus",
            },
          },
        }
      : {}),
  });
  const configPath = writeGatewayBenchConfig(root, config, {});
  fs.copyFileSync(configPath, path.join(output, "config.json"));
  const preload = fileURLToPath(new URL("./memory-search-status-observer.cjs", import.meta.url));
  const env = {
    ...createGatewayBenchEnv(root, configPath, { caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" } }),
    PGCENSUS_CONNECTION: process.env.PGCENSUS_CONNECTION,
    OPENCLAW_MEMORY_SEARCH_MEASURE_OUT: output,
    NODE_OPTIONS: `--require=${preload}`,
  };
  const launch = (args: string[], label: string) => {
    const fd = fs.openSync(path.join(output, `${label}.log`), "w");
    const child = spawn(process.execPath, ["dist/entry.js", ...args], {
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    fs.closeSync(fd);
    return child;
  };
  for (const [label, args] of [
    ["validate", ["config", "validate", "--json"]],
    ["index", ["memory", "index", "--force"]],
  ] as const) {
    const child = launch([...args], label);
    const [code] = await once(child, "close");
    assert.equal(code, 0, `${label} failed; see ${label}.log`);
  }
  const validation = JSON.parse(fs.readFileSync(path.join(output, "validate.log"), "utf8"));
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.warnings, []);
  gateway = launch(
    ["gateway", "run", "--port", String(port), "--bind", "loopback", "--auth", "trusted-proxy"],
    "gateway",
  );
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway?.exitCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway not ready");
  const challenge = Promise.withResolvers<string>();
  challengeTimer = setTimeout(
    () => challenge.reject(new Error("Gateway challenge timed out")),
    10_000,
  );
  void challenge.promise.catch(() => {});
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin: "http://census.example.test",
    headers: {
      "x-census-user": "census@example.test",
      "x-forwarded-for": "192.0.2.50",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "census.example.test",
    },
    onEvent(event) {
      if (event.event === "connect.challenge") {
        challenge.resolve((event.payload as { nonce: string }).nonce);
      }
    },
  });
  await client.waitOpen();
  const nonce = await challenge.promise;
  clearTimeout(challengeTimer);
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const id = createHash("sha256").update(raw).digest("hex");
  const scopes = ["operator.read"];
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: id,
    clientId: "openclaw-control-ui",
    clientMode: "ui",
    role: "operator",
    scopes,
    signedAtMs: signedAt,
    nonce,
    platform: process.platform,
  });
  const connected = await client.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "openclaw-control-ui", version: "1.0.0", platform: process.platform, mode: "ui" },
    role: "operator",
    scopes,
    device: {
      id,
      publicKey: raw.toString("base64url"),
      signature: sign(null, Buffer.from(payload), pair.privateKey).toString("base64url"),
      signedAt,
      nonce,
    },
  });
  assert(connected.ok, "Synthetic read-only connection was rejected");
  for (let index = 0; index < 10; index++) {
    const [name] = corpus[index % corpus.length]!;
    const startNs = process.hrtime.bigint().toString();
    const clock = performance.now();
    const result: GatewayReply = await client.request(
      "memory.search",
      { version: 1, agentId: "main", query: name, maxResults: 3, minScore: 0 },
      180_000,
    );
    assert(result.ok, `Search ${index} failed`);
    const response = result.payload as MemorySearchResponse;
    assert.equal(response.results[0]?.path, `memory/${name}.md`);
    samples.push({
      startNs,
      endNs: process.hrtime.bigint().toString(),
      wallMs: performance.now() - clock,
      response,
    });
  }
} finally {
  clearTimeout(challengeTimer);
  client?.close();
  if (gateway) {
    const stopped = await stopChild(gateway, { teardownGraceMs: 30_000 });
    assert.equal(stopped.exitCode, 0, "Gateway did not shut down cleanly");
  }
  fs.rmSync(root, { recursive: true, force: true });
}
const events = fs
  .readdirSync(output)
  .filter((name) => /^sql-.*\.jsonl$/.test(name))
  .flatMap((name) =>
    fs
      .readFileSync(path.join(output, name), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { timeNs: string; kind: string; engine?: string; sql?: string },
      ),
  );
const measured = samples.map((sample) => {
  const startNs = BigInt(sample.startNs);
  const endNs = BigInt(sample.endNs);
  const window = events.filter((event) => {
    const timeNs = BigInt(event.timeNs);
    return timeNs >= startNs && timeNs < endNs;
  });
  const statements = window.filter(
    (event) =>
      event.engine === engine && event.kind === (engine === "postgres" ? "diagnostic" : "native"),
  );
  return {
    startNs: sample.startNs,
    endNs: sample.endNs,
    wallMs: sample.wallMs,
    response: sample.response,
    statementCalls: statements.length,
    countStatements: statements.filter(
      (event) =>
        /COUNT\(\*\)/i.test(event.sql ?? "") &&
        /memory_embedding_cache|AS kind, source/i.test(event.sql ?? ""),
    ).length,
    workerRequests: window.filter((event) => event.kind === "worker").length,
  };
});
fs.writeFileSync(
  path.join(output, "result.json"),
  JSON.stringify(
    {
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      engine,
      node: process.version,
      samples: measured,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    engine,
    searches: measured.length,
    countStatements: measured.map((sample) => sample.countStatements),
  }),
);
if (process.env.PGCENSUS_EXPECT_COUNT_STATEMENTS !== undefined) {
  const expected = Number(process.env.PGCENSUS_EXPECT_COUNT_STATEMENTS);
  assert(
    Number.isInteger(expected) && expected >= 0,
    "Expected count must be a nonnegative integer",
  );
  measured.forEach((sample, index) => {
    assert.equal(sample.countStatements, expected, `Search ${index} full-status count statements`);
  });
}
