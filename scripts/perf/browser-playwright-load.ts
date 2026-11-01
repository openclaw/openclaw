/**
 * Probe a freshly built Gateway without starting or attaching a real browser:
 * node --import ./scripts/tsx.mjs scripts/perf/browser-playwright-load.ts \
 *   --entry ./dist/entry.js --output .local/browser-load-base --port 43721
 * Repeat on the candidate with --expect-unloaded. Output includes post-GC main
 * memory, CPU, GC and the CommonJS module-load census before/after status probes.
 * The mock CDP server answers only read-only discovery and health commands;
 * a Playwright session would send unsupported commands and fail the run.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "dist/entry.js" },
    output: { type: "string" },
    port: { type: "string", default: "43721" },
    samples: { type: "string", default: "20" },
    "expect-unloaded": { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new directory");
const entry = path.resolve(values.entry);
assert(path.basename(path.dirname(entry)) === "dist", "--entry must be a built dist entry");
const output = path.resolve(values.output);
const port = parseStrictIntegerOption({
  raw: values.port,
  label: "--port",
  min: 40000,
  fallback: 43721,
});
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "--samples",
  min: 1,
  fallback: 20,
});
assert(port < 65535, "--port must leave room for the mock CDP port");
mkdirSync(output);
mkdirSync(path.join(output, "home"));
mkdirSync(path.join(output, "tmp"));
const cdpUrl = `http://127.0.0.1:${port + 1}`;
const cdpWsUrl = `ws://127.0.0.1:${port + 1}/devtools/browser/synthetic`;
const commands: Record<string, number> = {};
const headers: Array<string | undefined> = [];
const unexpected: string[] = [];
const mock = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/json/version") {
    res.end(JSON.stringify({ Browser: "Chrome/130.0.0.0", webSocketDebuggerUrl: cdpWsUrl }));
  } else if (req.url === "/json/list" || req.url === "/json") {
    res.end(
      JSON.stringify([
        {
          id: "synthetic",
          type: "page",
          title: "Synthetic",
          url: "about:blank",
          webSocketDebuggerUrl: cdpWsUrl,
        },
      ]),
    );
  } else {
    unexpected.push(`HTTP ${req.method} ${req.url}`);
    res.writeHead(404).end("{}");
  }
});
const wsServer = new WebSocketServer({ server: mock });
wsServer.on("connection", (ws, req) => {
  headers.push(req.headers["user-agent"]);
  ws.on("message", (raw) => {
    const message: unknown = JSON.parse(rawDataToString(raw));
    assert(isRecord(message) && typeof message.method === "string");
    const method = message.method;
    commands[method] = (commands[method] ?? 0) + 1;
    if (method === "Browser.getVersion") {
      ws.send(
        JSON.stringify({
          id: message.id,
          result: { product: "Chrome/130.0.0.0", userAgent: "Synthetic", protocolVersion: "1.3" },
        }),
      );
    } else if (method === "Browser.getBrowserCommandLine") {
      ws.send(JSON.stringify({ id: message.id, result: { arguments: [] } }));
    } else if (method === "SystemInfo.getProcessInfo") {
      ws.send(JSON.stringify({ id: message.id, result: { processInfo: [] } }));
    } else {
      unexpected.push(method);
      ws.send(
        JSON.stringify({
          id: message.id,
          error: { code: -32601, message: "Unsupported synthetic probe command" },
        }),
      );
    }
  });
});

type Snapshot = {
  memory: NodeJS.MemoryUsage;
  mainCpu: NodeJS.CpuUsage;
  gcMs: number;
  playwrightModules: string[];
};
type GatewayClient = ReturnType<typeof createGatewayWsClient>;
let child: ChildProcess | undefined;
let client: GatewayClient | undefined;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Browser load probe interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const wait = (ms: number) => delay(ms, undefined, { signal: abort.signal });
async function snapshot(): Promise<Snapshot> {
  assert(child);
  const gateway = child;
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      gateway.off("message", onMessage);
      reject(new Error("Gateway memory observation timed out"));
    }, 30_000);
    const onMessage = (message: unknown) => {
      if (
        !isRecord(message) ||
        message.channel !== "browser-playwright-load" ||
        message.id !== id
      ) {
        return;
      }
      clearTimeout(timer);
      gateway.off("message", onMessage);
      resolve(message.snapshot as Snapshot);
    };
    gateway.on("message", onMessage);
    gateway.send({ channel: "browser-playwright-load", id });
  });
}

try {
  mock.listen(port + 1, "127.0.0.1");
  await once(mock, "listening");
  const origin = "https://browser-load.example";
  const configPath = path.join(output, "openclaw.json");
  const executablePath = path.join(output, "synthetic-browser");
  writeFileSync(executablePath, "Synthetic path; attach-only probes never launch it.\n");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...BASE_GATEWAY_BENCH_CONFIG,
      browser: {
        enabled: true,
        executablePath,
        defaultProfile: "probe",
        profiles: { probe: { attachOnly: true, cdpUrl } },
      },
      plugins: { enabled: true, allow: ["browser"], entries: { browser: { enabled: true } } },
      logging: { file: path.join(output, "gateway-file.log") },
      gateway: {
        ...BASE_GATEWAY_BENCH_CONFIG.gateway,
        controlUi: { enabled: false, allowedOrigins: [origin] },
        trustedProxies: ["127.0.0.1"],
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            allowLoopback: true,
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowUsers: ["browser-load"],
            deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
          },
        },
      },
    }),
  );
  const log = openSync(path.join(output, "gateway.log"), "w");
  try {
    child = spawn(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        fileURLToPath(new URL("./browser-playwright-load-preload.mjs", import.meta.url)),
        entry,
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: path.dirname(path.dirname(entry)),
        detached: true,
        stdio: ["ignore", log, log, "ipc"],
        env: createGatewayBenchEnv(path.join(output, "home"), configPath, {
          startupTrace: false,
          caseEnv: {
            TMPDIR: path.join(output, "tmp"),
            OPENCLAW_SKIP_CHANNELS: "1",
            NODE_DISABLE_COMPILE_CACHE: "1",
            OPENCLAW_PROFILE: `browser-load-${port}`,
            OPENCLAW_SYSTEMD_UNIT: `browser-load-${port}`,
          },
        }),
      },
    );
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + 180_000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) }).then(
      (res) => res.ok,
      () => false,
    ))
  ) {
    assert(
      child.exitCode === null && child.signalCode === null && Date.now() < deadline,
      "Gateway readiness failed; see gateway.log",
    );
    await wait(250);
  }
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    headers: {
      "x-forwarded-for": "192.0.2.1",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "browser-load",
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
  const challengeSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]);
  const onChallengeAbort = () => challenge.reject(challengeSignal.reason);
  const onChallengeClose = () => challenge.reject(new Error("Gateway closed before challenge"));
  client.ws.once("close", onChallengeClose);
  client.ws.once("error", challenge.reject);
  challengeSignal.addEventListener("abort", onChallengeAbort, { once: true });
  if (challengeSignal.aborted) {
    onChallengeAbort();
  }
  const [, { nonce, ts }] = await Promise.all([client.waitOpen(), challenge.promise]).finally(
    () => {
      client?.ws.off("close", onChallengeClose);
      client?.ws.off("error", challenge.reject);
      challengeSignal.removeEventListener("abort", onChallengeAbort);
    },
  );
  const identity = {
    id: "openclaw-control-ui",
    version: "1.0.0",
    platform: process.platform,
    mode: "ui",
  };
  const scopes = ["operator.read", "operator.write", "operator.admin"];
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const connected = await client.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: identity,
    role: "operator",
    scopes,
    device: {
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
    },
    caps: [],
  });
  assert(connected.ok, JSON.stringify(connected.error));
  const before = await snapshot();
  const hostLoadBefore = loadavg();
  const started = performance.now();
  const timings: number[] = [];
  for (let index = 0; index < samples; index++) {
    abort.signal.throwIfAborted();
    const at = performance.now();
    const response: Awaited<ReturnType<GatewayClient["request"]>> = await client.request(
      "browser.request",
      {
        method: "GET",
        path: index % 2 === 0 ? "/" : "/doctor",
        target: "host",
        query: { profile: "probe" },
      },
      30_000,
    );
    timings.push(performance.now() - at);
    assert(response.ok, JSON.stringify(response.error));
    assert(isRecord(response.payload), "browser response must be an object");
    if (index % 2 === 0) {
      assert.equal(response.payload.cdpReady, true, JSON.stringify(response.payload));
    }
  }
  const elapsedMs = performance.now() - started;
  const after = await snapshot();
  assert((commands["Browser.getVersion"] ?? 0) > 0, "No CDP health commands observed");
  assert.deepEqual(unexpected, [], "Probe attempted a browser session or unsupported command");
  const result = {
    entry,
    samples,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    elapsedMs,
    timings,
    before,
    after,
    commands,
    headers,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (values["expect-unloaded"]) {
    assert.deepEqual(after.playwrightModules, [], "Status probes loaded Playwright");
  }
} finally {
  client?.close();
  if (child) {
    await stopChild(child);
  }
  for (const ws of wsServer.clients) {
    ws.terminate();
  }
  wsServer.close();
  mock.closeAllConnections();
  await new Promise<void>((resolve) => {
    mock.close(() => resolve());
  });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
