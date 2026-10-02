/** Synthetic cron -> image_generate -> completion proof through a real Gateway WebSocket. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    samples: { type: "string", default: "5" },
    "image-delay-ms": { type: "string", default: "1250" },
    "cpu-profile": { type: "boolean", default: false },
    "count-waits": { type: "boolean", default: false },
    observer: { type: "string" },
  },
});
assert(values.out, "--out is required; use a new directory for each Gateway");
const samples = Number(values.samples);
const imageDelayMs = Number(values["image-delay-ms"]);
assert(Number.isSafeInteger(samples) && samples > 0, "--samples must be positive");
assert(Number.isSafeInteger(imageDelayMs) && imageDelayMs >= 0, "invalid --image-delay-ms");
const output = path.resolve(values.out);
// An existing fixture must never accidentally become the measured Gateway's state.
mkdirSync(output);
const fixture = path.join(output, "fixture");
const workspace = path.join(fixture, "workspace");
mkdirSync(workspace, { recursive: true });
const children: ChildProcess[] = [];
const marker = "MEDIA_COMPLETION_BENCH_OK";
const requestMarker = "MEDIA_COMPLETION_BENCH_GENERATE";
const evidence: Array<{
  sample: number;
  phase: string;
  imageRequests: number;
  modelRequests: number;
  detachedResultsBeforeImageCompletion: number;
  elapsedMs: number;
  proxyImageResponseToCronFinishMs: number;
  completed: boolean;
}> = [];
let phase = "boot";
type SampleState = {
  imageRequests: number;
  modelRequests: number;
  generationRequested: boolean;
  imageResponseFinishedAt?: number;
  detachedResultsBeforeImageCompletion: number;
};
const sampleStates = new Map<string, SampleState>();
let gatewayClient: ReturnType<typeof createGatewayWsClient> | undefined;
const setPhase = (next: string) => {
  phase = next;
  writeFileSync(path.join(output, "phase"), phase);
};
setPhase(phase);
function launch(args: string[], env: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  return child;
}
const mockPort = await getFreePort();
// Delay only image work. The ordinary mock owns model/tool-call response generation.
const proxy = createServer((req, res) => {
  void (async () => {
    let body: Buffer | undefined;
    let sample: SampleState | undefined;
    if (req.url === "/v1/chat/completions" || req.url === "/v1/images/generations") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
      const token = body.toString("utf8").match(/MEDIA_COMPLETION_BENCH_GENERATE_\d+/)?.[0];
      assert(token, "provider request did not carry its synthetic sample marker");
      sample = sampleStates.get(token);
      assert(sample, "unknown synthetic sample marker");
      if (req.url === "/v1/images/generations") {
        sample.imageRequests++;
        await delay(imageDelayMs);
      } else {
        sample.modelRequests++;
        const request = JSON.parse(body.toString("utf8")) as {
          model: string;
          messages: Array<{ role: string; content: unknown }>;
        };
        if (
          sample.imageResponseFinishedAt === undefined &&
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              JSON.stringify(message.content).includes(
                "Background task started for image generation",
              ),
          )
        ) {
          sample.detachedResultsBeforeImageCompletion++;
        }
        // A previous sample can still be delivering its completion. Its own marker
        // keeps that request from consuming the next sample's tool call.
        request.model = sample.generationRequested
          ? "synthetic-media-completion"
          : `synthetic-media-generation-${token}`;
        sample.generationRequested = true;
        body = Buffer.from(JSON.stringify(request));
      }
    }
    const headers = { ...req.headers };
    if (body) {
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.byteLength);
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: mockPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (reply) => {
        if (req.url === "/v1/images/generations") {
          res.once("finish", () => {
            sample!.imageResponseFinishedAt = performance.now();
          });
        }
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", (error) => res.destroy(error));
    if (body) {
      upstream.end(body);
    } else {
      req.pipe(upstream);
    }
  })().catch((error: unknown) =>
    res.destroy(error instanceof Error ? error : new Error(String(error))),
  );
});
try {
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const responseControl = path.join(fixture, "responses.json");
  writeFileSync(
    responseControl,
    JSON.stringify({
      models: {
        ...Object.fromEntries(
          Array.from({ length: samples + 1 }, (_, sample) => {
            const token = `${requestMarker}_${sample}`;
            return [
              `synthetic-media-generation-${token}`,
              {
                text: marker,
                toolCall: {
                  name: "dispatch_action",
                  arguments: {
                    id: "image_generate",
                    args: {
                      prompt: `${token}: Synthetic single blue pixel`,
                      model: "openai/gpt-image-1",
                    },
                  },
                },
              },
            ];
          }),
        ),
        "synthetic-media-completion": { text: marker },
      },
    }),
  );
  launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    {
      PATH: process.env.PATH,
      HOME: fixture,
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: responseControl,
    },
    "mock",
  );
  assert.equal(
    (
      await waitForInitialProbe({
        port: mockPort,
        path: "/health",
        startAt: performance.now(),
        deadlineAt: performance.now() + 30_000,
      })
    ).status,
    200,
    "mock provider readiness",
  );
  const cfg: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
  applyMockOpenAiModelConfig(cfg, {
    mockPort: address.port,
    modelRef: "openai/gpt-4.1",
    includeImageDefaults: true,
  });
  const provider = cfg.models?.providers?.openai;
  assert(provider);
  provider.api = "openai-completions";
  for (const model of provider.models) {
    model.api = "openai-completions";
  }
  cfg.browser = { enabled: false, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } };
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      skipBootstrap: true,
      modelPolicy: { allow: ["openai/gpt-4.1"] },
    },
  };
  delete cfg.agents.defaults?.models;
  cfg.tools = { codeMode: false, allow: ["image_generate"] };
  cfg.plugins = {
    ...cfg.plugins,
    entries: {
      ...cfg.plugins?.entries,
      "memory-core": { config: { dreaming: { enabled: false } } },
    },
  };
  const configPath = writeGatewayBenchConfig(fixture, cfg, {
    agentList: [{ id: "main", workspace }],
  });
  const nodeOptions: string[] = ["--enable-source-maps"];
  if (values.observer) {
    nodeOptions.push(`--require=${JSON.stringify(path.resolve(values.observer))}`);
  }
  if (values["count-waits"]) {
    // Counts mode intentionally trades overhead for source attribution; never use it for timing.
    const preload = path.join(output, "count-waits.cjs");
    writeFileSync(
      preload,
      `const {createHook}=require('node:async_hooks');\nconst fs=require('node:fs');\nconst counts={};\nif(require('node:worker_threads').isMainThread){createHook({init(_id,type){if(type==='Timeout' && new Error().stack.includes('attempt-async-tasks')){const phase=fs.readFileSync(${JSON.stringify(path.join(output, "phase"))},'utf8');counts[phase]=(counts[phase]??0)+1;}}}).enable();\nprocess.on('exit',()=>fs.writeFileSync(${JSON.stringify(path.join(output, "wait-timers.json"))},JSON.stringify(counts)));}\n`,
    );
    nodeOptions.push(`--require=${JSON.stringify(preload)}`);
  }
  const port = await getFreePort();
  const gateway = launch(
    buildGatewayBenchChildArgs(
      values.entry,
      port,
      values["cpu-profile"] ? gatewayBenchCpuProfileArgs(output) : [],
    ),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      OPENAI_API_KEY: "synthetic-media-fixture",
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: nodeOptions.join(" "),
    },
    "gateway",
  );
  assert.equal(
    (
      await waitForInitialProbe({
        port,
        path: "/readyz",
        startAt: performance.now(),
        deadlineAt: performance.now() + 300_000,
        isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
      })
    ).status,
    200,
    "Gateway readiness",
  );
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  gatewayClient = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent: (event) => {
      if (event.event === "connect.challenge" && isRecord(event.payload)) {
        const { nonce, ts } = event.payload;
        if (typeof nonce === "string" && typeof ts === "number") {
          challenge.resolve({ nonce, ts });
        }
      }
    },
  });
  const challengeTimer = setTimeout(
    () => challenge.reject(new Error("Gateway challenge timeout")),
    10_000,
  );
  void challenge.promise.catch(() => {});
  let challengeValue: Awaited<typeof challenge.promise>;
  try {
    await gatewayClient.waitOpen();
    challengeValue = await challenge.promise;
  } finally {
    clearTimeout(challengeTimer);
  }
  const pair = generateKeyPairSync("ed25519");
  const rawPublicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const deviceId = createHash("sha256").update(rawPublicKey).digest("hex");
  const scopes = ["operator.read", "operator.write", "operator.admin"];
  const devicePayload = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: "gateway-client",
    clientMode: "ui",
    role: "operator",
    scopes,
    signedAtMs: challengeValue.ts,
    nonce: challengeValue.nonce,
    platform: process.platform,
  });
  const rpc = async <T,>(method: string, params: unknown): Promise<T> => {
    const response = await gatewayClient!.request(method, params, 120_000);
    assert(response.ok, `${method} failed: ${JSON.stringify(response.error)}`);
    return response.payload as T;
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "media-completion-benchmark",
      version: "1.0.0",
      platform: process.platform,
      mode: "ui",
    },
    role: "operator",
    scopes,
    device: {
      id: deviceId,
      publicKey: rawPublicKey.toString("base64url"),
      signature: sign(null, Buffer.from(devicePayload), pair.privateKey).toString("base64url"),
      signedAt: challengeValue.ts,
      nonce: challengeValue.nonce,
    },
    caps: [],
  });
  for (let sample = 0; sample <= samples; sample++) {
    setPhase(sample === 0 ? "cold" : `warm-${sample}`);
    const token = `${requestMarker}_${sample}`;
    const state: SampleState = {
      imageRequests: 0,
      modelRequests: 0,
      generationRequested: false,
      detachedResultsBeforeImageCompletion: 0,
    };
    sampleStates.set(token, state);
    // Independent cron identities prevent a still-delivering completion from
    // colliding with admission of the following sample.
    const job = await rpc<{ id: string }>("cron.add", {
      name: `synthetic-media-completion-${sample}`,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: `${token}: Generate the synthetic image, then confirm completion.`,
        toolsAllow: ["image_generate"],
        timeoutSeconds: 60,
      },
      delivery: { mode: "none" },
    });
    const startedAt = performance.now();
    const result = await rpc<{ run?: { status?: string; error?: string; summary?: string } }>(
      "cron.run",
      { id: job.id, mode: "force", waitTimeoutMs: 110_000 },
    );
    const finishedAt = performance.now();
    assert.equal(result.run?.status, "ok", `cron did not finish: ${JSON.stringify(result)}`);
    assert.equal(state.imageRequests, 1, "expected one actual image generation per cron run");
    assert(state.modelRequests >= 2, "expected image tool call then final response");
    assert(result.run?.summary?.includes(marker), "missing synthetic final response marker");
    assert(state.imageResponseFinishedAt !== undefined, "image proxy response did not finish");
    assert(
      state.detachedResultsBeforeImageCompletion > 0,
      "tool did not return detached work before the image completed; this did not exercise completion waiting",
    );
    evidence.push({
      sample,
      phase,
      imageRequests: state.imageRequests,
      modelRequests: state.modelRequests,
      detachedResultsBeforeImageCompletion: state.detachedResultsBeforeImageCompletion,
      elapsedMs: finishedAt - startedAt,
      // Proxy response timing includes transport and post-image work, not exact owner settlement.
      proxyImageResponseToCronFinishMs: finishedAt - state.imageResponseFinishedAt,
      completed: true,
    });
  }
} finally {
  setPhase("shutdown");
  gatewayClient?.close();
  for (const child of children.toReversed()) {
    await stopChild(child, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
  }
  await new Promise<void>((resolve, reject) => {
    proxy.close((error) => (error ? reject(error) : resolve()));
  });
}
// Final counters include late completion requests that arrived after cron.run.
for (const item of evidence) {
  const state = sampleStates.get(`${requestMarker}_${item.sample}`)!;
  item.modelRequests = state.modelRequests;
  item.imageRequests = state.imageRequests;
}
const result = {
  workload: "media-completion-gateway",
  imageDelayMs,
  evidence,
  ...(values["count-waits"]
    ? {
        waitTimers: JSON.parse(
          readFileSync(path.join(output, "wait-timers.json"), "utf8"),
        ) as Record<string, number>,
      }
    : {}),
};
writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
