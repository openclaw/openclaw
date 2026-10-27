/**
 * Isolated built-Gateway 429 retention reproduction, with real HTTP Responses and backoff.
 * node --import ./scripts/tsx.mjs scripts/perf/same-model-retry-gateway.ts
 *   --output .local/retry-base --entry dist/entry.js
 * Repeat on the candidate build. Synthetic history/images only; no external provider.
 * Captures post-GC heap per retry while the logical run remains alive. Forced GC and
 * allocation sampling make these retention diagnostics, not latency acceptance gates.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { encodePngRgba } from "../../src/media/png-encode.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
  },
});
assert(values.output, "--output must be a new task-owned directory");
const root = path.resolve(values.output);
mkdirSync(root);
mkdirSync(path.join(root, "tmp"));
mkdirSync(path.join(root, "workspace"));
const preload = path.join(root, "heap-probe.mjs");
writeFileSync(
  preload,
  `
import { isMainThread } from 'node:worker_threads';
import { Session } from 'node:inspector/promises';
import { loadavg } from 'node:os';
if (isMainThread) {
  const inspector = new Session(); inspector.connect();
  let previousCpu = process.threadCpuUsage();
  process.on('message', async message => {
    if (message?.channel !== 'retry-heap') return;
    if (message.start) {
      await inspector.post('HeapProfiler.startSampling', {
        samplingInterval: 32768, includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true });
      previousCpu = process.threadCpuUsage();
    }
    global.gc(); global.gc();
    const cpu = process.threadCpuUsage(previousCpu);
    const { profile } = await inspector.post('HeapProfiler.getSamplingProfile');
    process.send({ channel: message.channel, id: message.id,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes: profile.samples.reduce((n,s) => n+s.size,0),
      memory: process.memoryUsage(), hostLoad: loadavg() });
  });
}
`,
);

async function freePort() {
  for (;;) {
    const server = createPortServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (address.port >= 40000) {
      return address.port;
    }
  }
}
const requests: Array<{
  scenario: string;
  attempt: number;
  bytes: number;
  sha256: string;
  inputSha256: string;
  images: number;
}> = [];
const counts = new Map<string, number>();
const provider = createServer((request, response) => {
  request.setEncoding("utf8");
  let raw = "";
  request.on("data", (chunk: string) => {
    raw += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(raw) as { input: unknown[] };
    const scenario = raw.includes("RETRY_EXHAUST")
      ? "exhaust"
      : raw.includes("RETRY_SUCCESS")
        ? "success"
        : "seed";
    const attempt = (counts.get(scenario) ?? 0) + 1;
    counts.set(scenario, attempt);
    requests.push({
      scenario,
      attempt,
      bytes: Buffer.byteLength(raw),
      sha256: createHash("sha256").update(raw).digest("hex"),
      inputSha256: createHash("sha256").update(JSON.stringify(payload.input)).digest("hex"),
      images: raw.split('"input_image"').length - 1,
    });
    if (scenario === "exhaust" || (scenario === "success" && attempt <= 3)) {
      response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "1" });
      response.end(
        JSON.stringify({
          error: {
            code: "rate_limit_exceeded",
            type: "tokens",
            message: "Synthetic rate limit reached; try again shortly.",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const output = [
      {
        type: "message",
        id: `msg_${scenario}_${attempt}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Synthetic success.", annotations: [] }],
      },
    ];
    response.end(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: `resp_${scenario}_${attempt}`,
          status: "completed",
          output,
          usage: { input_tokens: 100, output_tokens: 4, total_tokens: 104 },
        },
      })}\n\n`,
    );
  });
});
const providerPort = await freePort();
provider.listen(providerPort, "127.0.0.1");
await once(provider, "listening");
const port = await freePort();
const config: OpenClawConfig = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  cron: { enabled: false },
  agents: {
    defaults: { timeoutSeconds: 1800, compaction: { enabled: false } },
    entries: { main: { workspace: path.join(root, "workspace") } },
  },
  logging: { file: path.join(root, "gateway.log") },
};
applyMockOpenAiModelConfig(config, { mockPort: providerPort, modelRef: "openai/gpt-4.1" });
const mockModels = config.models?.providers?.openai?.models;
assert(mockModels);
for (const model of mockModels) {
  model.contextWindow = 2_097_152;
  model.contextTokens = 2_000_000;
}
const configPath = path.join(root, "openclaw.json");
writeFileSync(configPath, JSON.stringify(config));
const env = createGatewayBenchEnv(root, configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENAI_API_KEY: "synthetic-retry-fixture",
    OPENCLAW_PROFILE: "l1914-synthetic",
    NODE_DISABLE_COMPILE_CACHE: "1",
    TMPDIR: path.join(root, "tmp"),
  },
});
const log = createWriteStream(path.join(root, "process.log"));
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(path.resolve(values.entry), port, [
    "--expose-gc",
    "--import",
    preload,
  ]),
  { env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
);
gateway.stdout?.pipe(log);
gateway.stderr?.pipe(log);
const samples: unknown[] = [];
let client: ReturnType<typeof createGatewayWsClient> | undefined;
function sample(label: string, start = false) {
  return new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      gateway.off("message", receive);
      reject(new Error("heap sample timeout"));
    }, 30_000);
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message) || message.id !== id) {
        return;
      }
      clearTimeout(timeout);
      gateway.off("message", receive);
      samples.push({ label, at: Date.now(), ...message });
      writeFileSync(path.join(root, "samples.json"), JSON.stringify(samples, null, 2));
      console.log(JSON.stringify(samples.at(-1)));
      resolve();
    };
    gateway.on("message", receive);
    gateway.send({ channel: "retry-heap", id, start });
  });
}
let sampleChain = Promise.resolve();
try {
  const deadline = Date.now() + 600_000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    assert(
      gateway.exitCode === null && gateway.signalCode === null,
      "Gateway exited; inspect process.log",
    );
    assert(Date.now() < deadline, "Gateway readiness timed out");
    await delay(500);
  }
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent(event) {
      const payload = event.payload as
        | { stream?: string; data?: { phase?: string; retryAttempt?: number } }
        | undefined;
      if (
        event.event === "agent" &&
        payload?.stream === "run_status" &&
        payload.data?.phase === "retrying"
      ) {
        const label = `retry-${payload.data.retryAttempt}`;
        sampleChain = sampleChain.then(() => delay(100)).then(() => sample(label));
      }
    },
  });
  await client.waitOpen();
  async function rpc(method: string, params: unknown, timeout = 60_000) {
    assert(client);
    const result = await client.request(method, params, timeout);
    assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
    return result.payload;
  }
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps: [],
  });
  // Deterministic incompressible pixels keep baseline/candidate request bytes comparable.
  const pixels = createCipheriv("aes-256-ctr", Buffer.alloc(32, 11), Buffer.alloc(16, 7)).update(
    Buffer.alloc(512 * 512 * 4),
  );
  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i] = 255;
  }
  const image = encodePngRgba(pixels, 512, 512).toString("base64");
  for (const scenario of ["success", "exhaust"]) {
    const sessionKey = `agent:main:retry-${scenario}`;
    await rpc("sessions.create", { key: sessionKey, visibility: "shared" });
    for (let turn = 0; turn < 32; turn++) {
      await rpc("chat.inject", {
        sessionKey,
        message: `Synthetic history ${turn}. ${"history fixture ".repeat(1024)}`,
      });
    }
    await sample(`${scenario}-before`, scenario === "success");
    const runId = randomUUID();
    await rpc("chat.send", {
      sessionKey,
      message: `RETRY_${scenario.toUpperCase()}: inspect the synthetic history and image.`,
      idempotencyKey: runId,
      deliver: false,
      attachments: [
        { type: "file", mimeType: "image/png", fileName: "synthetic.png", content: image },
      ],
    });
    let terminal: unknown;
    do {
      terminal = await rpc("agent.wait", { runId, timeoutMs: 120_000 }, 150_000);
      if ((terminal as { status?: string }).status === "pending") {
        await delay(500);
      }
    } while (["timeout", "pending"].includes((terminal as { status: string }).status));
    await sampleChain;
    await sample(`${scenario}-settled`);
    writeFileSync(path.join(root, `${scenario}-terminal.json`), JSON.stringify(terminal, null, 2));
    assert.equal((terminal as { status: string }).status, scenario === "success" ? "ok" : "error");
    assert.equal(counts.get(scenario), scenario === "success" ? 4 : 16);
    assert(requests.filter((r) => r.scenario === scenario).every((r) => r.images > 0));
  }
} finally {
  client?.close();
  await stopChild(gateway);
  provider.closeAllConnections();
  await new Promise<void>((resolve) => {
    provider.close(() => resolve());
  });
  writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
  log.end();
}
