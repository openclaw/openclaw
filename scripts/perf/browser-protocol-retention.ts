/**
 * Synthetic managed-browser route workload; never attaches to a user profile.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/browser-protocol-retention.ts \
 *   --output .local/browser-retention/base --executable /path/to/chromium --mode mixed
 * Modes console/wait/requests isolate the producers; mixed also navigates/snapshots.
 * Default: 3 x 200 steps, 20 console arguments and 20 fetches/step. Snapshots
 * measure the browser owner's Node isolate, not Chromium or a full Gateway.
 * Use --measure timing or allocation for separate untraced/sampled owner costs;
 * run five counterbalanced baseline/candidate pairs plus unchanged A/A controls.
 * Acceptance: handles plateau after warmup, request dispatchers plateau at the
 * dependency bound, close releases page-owned protocol objects; preserve outputs.
 * Owner baselines can replace modules via --state-owner and --wait-owner.
 * --gateway-entry /checkout/src/entry.ts instead boots a real isolated Gateway,
 * drives browser.request over WebSocket, and captures its main isolate via IPC.
 * Gateway baselines require a checkout at the baseline revision, since plugins
 * evaluate generation captures. The preload records both loaded owner hashes.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stopChild, delay } from "../lib/gateway-bench-child.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    executable: { type: "string" },
    mode: { type: "string", default: "mixed" },
    measure: { type: "string", default: "heap" },
    steps: { type: "string", default: "200" },
    rounds: { type: "string", default: "3" },
    batch: { type: "string", default: "20" },
    port: { type: "string", default: "43841" },
    "state-owner": { type: "string" },
    "wait-owner": { type: "string" },
    "gateway-entry": { type: "string" },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
assert(values.output, "--output must name a new directory");
assert(["mixed", "console", "wait", "requests"].includes(values.mode));
assert(["heap", "timing", "allocation"].includes(values.measure));
assert(
  !values["gateway-entry"] || values.measure === "heap",
  "Gateway mode captures heap only; owner mode measures CPU/allocation",
);
assert(
  !values["gateway-entry"] || (!values["state-owner"] && !values["wait-owner"]),
  "Gateway baselines require an actual baseline checkout",
);
const integer = (name: "steps" | "rounds" | "batch" | "port", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback });
const steps = integer("steps", 200);
const rounds = integer("rounds", 3);
const batch = integer("batch", 20);
const port = integer("port", 43841);
assert(port >= 40000 && port < 65535);
const output = path.resolve(values.output);
mkdirSync(output, { recursive: false, mode: 0o700 });
const stateDir = path.join(output, "state");
mkdirSync(stateDir);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = path.join(output, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
const replacedState = registerPerfOwnerReplacement(
  new URL("../../extensions/browser/src/browser/pw-session-state.ts", import.meta.url).href,
  values["state-owner"],
);
const replacedWait = registerPerfOwnerReplacement(
  new URL(
    "../../extensions/browser/src/browser/pw-tools-core.interactions.content.ts",
    import.meta.url,
  ).href,
  values["wait-owner"],
);
const { resolveBrowserConfig, createBrowserRouteContext, createBrowserRouteDispatcher } =
  await import("../../extensions/browser/benchmark-api.ts");
const browserConfig = {
  enabled: true,
  headless: true,
  executablePath: values.executable,
  defaultProfile: "retention",
  evaluateEnabled: true,
  ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  profiles: { retention: { cdpPort: port } },
};
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ browser: browserConfig }));
const state = { port: 0, resolved: resolveBrowserConfig(browserConfig), profiles: new Map() };
const dispatcher = createBrowserRouteDispatcher(
  createBrowserRouteContext({ getState: () => state }),
);
let gateway: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
async function call(
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: Record<string, unknown>,
) {
  if (client) {
    const response = await client.request(
      "browser.request",
      {
        method,
        path: route,
        target: "host",
        query: { profile: "retention", ...(method === "GET" ? body : {}) },
        body: method === "GET" ? undefined : body,
      },
      120_000,
    );
    assert(response.ok, `${method} ${route}: ${JSON.stringify(response.error)}`);
    assert(isRecord(response.payload));
    return response.payload;
  }
  const result = await dispatcher.dispatch({
    method,
    path: route,
    query: { profile: "retention", ...(method === "GET" ? body : {}) },
    body: method === "GET" ? undefined : body,
  });
  assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`);
  assert(result.body && typeof result.body === "object");
  return result.body as Record<string, unknown>;
}

const classes = new Set([
  "_JSHandle",
  "JSHandle",
  "_ElementHandle",
  "ElementHandle",
  "JSHandleDispatcher",
  "_JSHandleDispatcher",
  "_Request",
  "Request",
  "_Response",
  "Response",
  "Response2",
  "RequestDispatcher",
  "_RequestDispatcher",
  "ResponseDispatcher",
  "ManualPromise",
  "_RawHeaders",
  "RawHeaders",
  "MultiMap",
  "ConsoleMessage",
  "ConsoleMessage2",
]);
type Heap = {
  snapshot: { meta: { node_fields: string[]; node_types: Array<string[] | string> } };
  nodes: number[];
  strings: string[];
};
async function snapshot(label: string) {
  globalThis.gc?.();
  let memory = process.memoryUsage();
  const filename = path.join(output, `${label}.heapsnapshot`);
  let sources: unknown;
  if (gateway) {
    const child = gateway;
    memory = await new Promise<NodeJS.MemoryUsage>((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        child.off("message", onMessage);
        child.off("exit", onExit);
        reject(new Error("Gateway heap snapshot timed out"));
      }, 120_000);
      const onExit = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        reject(new Error("Gateway exited during heap snapshot"));
      };
      const onMessage = (message: unknown) => {
        if (
          !isRecord(message) ||
          message.channel !== "browser-protocol-retention" ||
          message.id !== id
        ) {
          return;
        }
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (typeof message.error === "string") {
          reject(new Error(message.error));
          return;
        }
        sources = message.sources;
        resolve(message.memory as NodeJS.MemoryUsage);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ channel: "browser-protocol-retention", id, filename });
    });
  } else {
    writeHeapSnapshot(filename);
  }
  const heap = JSON.parse(readFileSync(filename, "utf8")) as Heap;
  const fields = heap.snapshot.meta.node_fields;
  const typeOffset = fields.indexOf("type");
  const nameOffset = fields.indexOf("name");
  const sizeOffset = fields.indexOf("self_size");
  const types = heap.snapshot.meta.node_types[typeOffset];
  assert(Array.isArray(types));
  const counts: Record<string, { count: number; selfBytes: number }> = {};
  for (let offset = 0; offset < heap.nodes.length; offset += fields.length) {
    const nodeType = heap.nodes[offset + typeOffset];
    const nameIndex = heap.nodes[offset + nameOffset];
    const size = heap.nodes[offset + sizeOffset];
    assert(nodeType !== undefined && nameIndex !== undefined && size !== undefined);
    if (types[nodeType] !== "object") {
      continue;
    }
    const name = heap.strings[nameIndex];
    assert(name !== undefined);
    if (!classes.has(name)) {
      continue;
    }
    const value = counts[name] ?? (counts[name] = { count: 0, selfBytes: 0 });
    value.count++;
    value.selfBytes += size;
  }
  return { label, memory, counts, sources };
}

let received = 0;
const server = createServer((req, res) => {
  if (req.url?.startsWith("/data")) {
    received++;
    res.setHeader("Content-Type", "application/json").end(JSON.stringify({ synthetic: received }));
  } else {
    res
      .setHeader("Content-Type", "text/html")
      .end(
        "<!doctype html><title>Synthetic retention workload</title><main><h1>Fixture</h1><button onclick=\"this.textContent='Clicked'\">Action</button></main>",
      );
  }
});
const inspector = new Session();
const snapshots: Awaited<ReturnType<typeof snapshot>>[] = [];
const measurements: Array<{ wallMs: number; cpuMs: number; allocatedBytes?: number }> = [];
try {
  if (values["gateway-entry"]) {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    writeFileSync(
      configPath,
      JSON.stringify({
        ...BASE_GATEWAY_BENCH_CONFIG,
        meta: { migrations: { skillWorkshopPlugin: true } },
        browser: browserConfig,
        plugins: { enabled: true, allow: ["browser"], entries: { browser: { enabled: true } } },
        logging: { file: path.join(output, "gateway-file.log") },
      }),
    );
    const gatewayPort = port + 1;
    const log = createWriteStream(path.join(output, "gateway.log"));
    const preload = new URL("./browser-protocol-retention-preload.ts", import.meta.url);
    gateway = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(path.resolve(values["gateway-entry"]), gatewayPort, [
        "--expose-gc",
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--import",
        preload.href,
      ]),
      {
        cwd: path.dirname(path.dirname(path.resolve(values["gateway-entry"]))),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
        env: createGatewayBenchEnv(path.join(output, "home"), configPath, {
          startupTrace: false,
          caseEnv: {
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_PROFILE: `retention-${gatewayPort}`,
          },
        }),
      },
    );
    gateway.stdout?.pipe(log);
    gateway.stderr?.pipe(log);
    gateway.once("close", () => log.end());
    const deadline = Date.now() + 180_000;
    while (
      !(await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, {
        signal: AbortSignal.timeout(1000),
      }).then(
        (res) => res.ok,
        () => false,
      ))
    ) {
      assert(
        gateway.exitCode === null && gateway.signalCode === null && Date.now() < deadline,
        "Gateway readiness failed; see gateway.log",
      );
      await delay(250);
    }
    client = createGatewayWsClient({ url: `ws://127.0.0.1:${gatewayPort}` });
    await client.waitOpen();
    const response = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "synthetic-browser-retention",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
    });
    assert(response.ok, JSON.stringify(response.error));
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/`;
  await call("POST", "/start");
  const opened = await call("POST", "/tabs/open", { url });
  const targetId = opened.targetId;
  assert(typeof targetId === "string", JSON.stringify(opened));
  const consoleCode = ["console", "mixed"].includes(values.mode)
    ? `for(let i=0;i<${batch};i++) console.log({synthetic:i, text:'fixture'});`
    : "";
  const requestCode = ["requests", "mixed"].includes(values.mode)
    ? `await Promise.all(Array.from({length:${batch}},(_,i)=>fetch('/data?i='+i).then(r=>r.json())));`
    : "";
  async function step(index: number) {
    await call("POST", "/act", {
      targetId,
      kind: "evaluate",
      fn: `async () => {${consoleCode}${requestCode} return 'complete';}`,
    });
    if (["wait", "mixed"].includes(values.mode)) {
      await call("POST", "/act", {
        targetId,
        kind: "wait",
        fn: "() => document.querySelector('main')",
        timeoutMs: 5000,
      });
    }
    if (values.mode === "mixed" && index % 50 === 0) {
      await call("GET", "/snapshot", { targetId, format: "ai" });
      await call("POST", "/navigate", { targetId, url: `${url}?step=${index}` });
    }
  }
  await step(-1);
  if (values.measure === "heap") {
    snapshots.push(await snapshot("warm"));
  }
  const hostLoadBefore = loadavg();
  for (let round = 0; round < rounds; round++) {
    globalThis.gc();
    if (values.measure === "allocation") {
      await startCollectedHeapSampling(inspector, 32768);
    }
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    for (let index = 0; index < steps; index++) {
      await step(round * steps + index);
    }
    const wallMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    let allocatedBytes: number | undefined;
    if (values.measure === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocatedBytes = sumSampledHeapBytes(profile.head);
      inspector.disconnect();
    }
    measurements.push({ wallMs, cpuMs: (used.user + used.system) / 1000, allocatedBytes });
    if (values.measure === "heap") {
      snapshots.push(await snapshot(`round-${round + 1}`));
    }
    console.log(
      JSON.stringify({
        round: round + 1,
        received,
        ...measurements.at(-1),
        snapshot: snapshots.at(-1),
      }),
    );
  }
  const requests = await call("GET", "/requests", { targetId });
  assert(Array.isArray(requests.requests));
  if (requestCode) {
    assert(
      requests.requests.some(
        (request) => request.url.includes("/data") && request.status === 200 && request.ok === true,
      ),
    );
    assert.equal(received, (1 + rounds * steps) * batch);
  }
  const consoleMessages = await call("GET", "/console", { targetId });
  assert(Array.isArray(consoleMessages.messages));
  if (consoleCode) {
    assert(
      consoleMessages.messages.some(
        (message) => message.type === "log" && message.text.includes("fixture"),
      ),
    );
  }
  await call("DELETE", `/tabs/${targetId}`);
  if (values.measure === "heap") {
    snapshots.push(await snapshot("closed"));
  }
  assert(
    gateway || !values["state-owner"] || replacedState(),
    "Baseline state owner was not loaded",
  );
  assert(gateway || !values["wait-owner"] || replacedWait(), "Baseline wait owner was not loaded");
  const result = {
    values,
    node: process.version,
    received,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    measurements,
    snapshots,
    recentRequests: requests.requests.length,
    recentConsoleMessages: consoleMessages.messages.length,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
} finally {
  inspector.disconnect();
  try {
    await call("POST", "/stop");
  } finally {
    try {
      client?.close();
      if (gateway) {
        await stopChild(gateway, { teardownGraceMs: 10_000 });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}
