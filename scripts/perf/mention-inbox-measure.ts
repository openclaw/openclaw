// Synthetic authenticated Inbox reads and broadcasts through the real Gateway.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { requestSessionListParams } from "../../ui/src/lib/sessions/session-requests.ts";
import type { SessionRequestClient } from "../../ui/src/lib/sessions/session-types.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { readBody } from "../e2e/lib/mock-openai-http.mjs";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "41605" },
    "mock-port": { type: "string", default: "41606" },
    sessions: { type: "string", default: "5000" },
    runs: { type: "string", default: "6000" },
    mentions: { type: "string", default: "40" },
    clients: { type: "string", default: "24" },
    operations: { type: "string", default: "2000" },
    broadcasts: { type: "string", default: "100" },
    "sidebar-limit": { type: "string", default: "0" },
    "broadcast-allocation-start-at": { type: "string" },
    "start-at": { type: "string" },
    "cpu-start-at": { type: "string" },
    "broadcast-start-at": { type: "string" },
    "owner-dir": { type: "string" },
    "count-only": { type: "boolean", default: false },
    "trace-log": { type: "string" },
    "barrier-dir": { type: "string" },
    side: { type: "string", default: "run" },
  },
});
const integer = (raw: string | undefined, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, fallback: min, min });
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const root = path.resolve(values["state-dir"]);
const port = integer(values.port, "port", 40000);
const mockPort = integer(values["mock-port"], "mock-port", 40000);
assert(port <= 65535 && mockPort <= 65535 && port !== mockPort);
const mentions = integer(values.mentions, "mentions");
const clients = integer(values.clients, "clients");
const operations = integer(values.operations, "operations");
const broadcasts = integer(values.broadcasts, "broadcasts");
const sidebarLimit = integer(values["sidebar-limit"], "sidebar-limit", 0);
const counts = {
  readTarget: 0,
  currentTarget: 0,
  readView: 0,
  shareSidebarSessionRows: 0,
  sidebarFull: 0,
  sidebarDelta: 0,
  sidebarUnchanged: 0,
};
const hooks: string[] = [];
const observerKey = Symbol.for("openclaw.bench.mention-counts");
Object.defineProperty(globalThis, observerKey, { value: counts });
const originalTarget = new URL("../../src/gateway/mention-inbox-targets.ts", import.meta.url).href;
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const ownerNames = [
      "mention-inbox-targets.ts",
      "mention-inbox.ts",
      "mention-inbox-projection.ts",
      "mention-inbox-recording.ts",
      "session-row-presentation.ts",
    ];
    const replaced =
      values["owner-dir"] && ownerNames.find((name) => url.endsWith(`/src/gateway/${name}`));
    if (replaced) {
      loaded.source = stripTypeScriptTypes(
        readFileSync(path.resolve(values["owner-dir"]!, replaced), "utf8"),
      );
    }
    const names =
      url === originalTarget
        ? ["readTarget"]
        : url.endsWith("/src/gateway/mention-inbox.ts")
          ? ["currentTarget", "readView"]
          : url.endsWith("/src/gateway/session-row-presentation.ts")
            ? ["shareSidebarSessionRows"]
            : [];
    if (!names.length) {
      return loaded;
    }
    let source =
      typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    for (const name of names) {
      const pattern = new RegExp(`(function ${name}\\([\\s\\S]*?\\{)`);
      assert(pattern.test(source), `missing source counter hook: ${name}`);
      source = source.replace(
        pattern,
        `$1globalThis[Symbol.for("openclaw.bench.mention-counts")].${name}++;\n`,
      );
      hooks.push(name);
    }
    return { ...loaded, source };
  },
});
function markGc(phase: string, profilePath?: string) {
  if (process.execArgv.includes("--trace-gc-nvp")) {
    writeGatewayGcTraceMarker(phase, profilePath);
  }
}
if (process.execArgv.includes("--trace-gc-nvp")) {
  assert(global.gc, "trace identification requires --expose-gc");
  markGc("identify-start");
  global.gc();
  markGc("identify-stop");
}
const fixture = await generateTeamShapeFixture(
  parseTeamShapeOptions([
    "--state-dir",
    root,
    "--sessions",
    values.sessions!,
    "--runs",
    values.runs!,
    "--settled-runs",
    "--transcript-mib",
    "0",
    "--projects",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--port",
    String(port),
    "--now",
    String(Date.now()),
  ]),
);
process.env = { ...fixture.env, OPENAI_API_KEY: "synthetic-loopback-only" };
const configPath = path.join(root, "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const origin = `http://127.0.0.1:${port}`;
const emails = ["alice@mention-bench.example.test", "bob@mention-bench.example.test"];
config.gateway.auth = {
  mode: "trusted-proxy",
  trustedProxy: {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowUsers: emails,
    allowLoopback: true,
    deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
  },
  identityScopes: Object.fromEntries(emails.map((email) => [email, ["operator.admin"]])),
};
config.gateway.trustedProxies = ["127.0.0.1", "::1"];
config.gateway.controlUi = { enabled: false, allowedOrigins: [origin] };
config.gateway.roles = {
  default: "administrator",
  definitions: {
    administrator: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
  },
};
applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-4.1-mini" });
config.agents.defaults.skipBootstrap = true;
config.plugins = {
  enabled: true,
  allow: ["openai"],
  slots: { memory: "none" },
  load: { paths: [path.resolve("extensions/openai")] },
};
config.tools = { profile: "minimal" };
writeFileSync(configPath, JSON.stringify(config));
let modelRequests = 0;
const model = createServer((request, response) => {
  void (async () => {
    await readBody(request);
    modelRequests++;
    const item = {
      type: "message",
      id: `msg_${modelRequests}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Acknowledged.", annotations: [] }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    send({
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "Acknowledged.",
    });
    send({ type: "response.output_item.done", output_index: 0, item });
    send({
      type: "response.completed",
      response: {
        id: `resp_${modelRequests}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    });
    response.end("data: [DONE]\n\n");
  })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
});
await new Promise<void>((resolve) => {
  model.listen(mockPort, "127.0.0.1", resolve);
});
const { startGatewayServer } = await import("../../src/gateway/server.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const peers: ReturnType<typeof createGatewayWsClient>[] = [];
const changedByViewer = new Map<number, number>();
const inspector = new Session();
async function rpc(
  peer: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  const result = await peer.request(method, params, 120_000);
  assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
  assert(isRecord(result.payload), `${method}: invalid response`);
  return result.payload;
}
async function connect(email: string, index: number) {
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  const peer = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    headers: {
      "x-forwarded-user": email,
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
    },
    onEvent(event) {
      if (event.event === "connect.challenge" && isRecord(event.payload)) {
        challenge.resolve(event.payload as { nonce: string; ts: number });
      }
      if (event.event === "mentions.changed") {
        changedByViewer.set(index, (changedByViewer.get(index) ?? 0) + 1);
      }
    },
  });
  peers.push(peer);
  await peer.waitOpen();
  const timer = setTimeout(() => challenge.reject(new Error("challenge timeout")), 15_000);
  const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timer));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const client = {
    id: "openclaw-control-ui",
    version: "dev",
    platform: "web",
    mode: "webchat",
    instanceId: `mention-viewer-${index}`,
  };
  const scopes = ["operator.admin"];
  const signed = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: client.id,
    clientMode: client.mode,
    platform: client.platform,
    role: "operator",
    scopes,
    signedAtMs: ts,
    nonce,
  });
  await rpc(peer, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role: "operator",
    scopes,
    device: {
      id: deviceId,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        signed,
      ),
    },
  });
  return peer;
}
function resetCounts() {
  counts.readTarget = 0;
  counts.currentTarget = 0;
  counts.readView = 0;
  counts.shareSidebarSessionRows = 0;
  counts.sidebarFull = 0;
  counts.sidebarDelta = 0;
  counts.sidebarUnchanged = 0;
}
function tails(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    p95Ms: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null,
    p99Ms: samples.length ? samples[Math.ceil(samples.length * 0.99) - 1] : null,
    maxMs: samples.at(-1) ?? null,
  };
}
async function waitStart(raw: string | undefined, label: string) {
  let startValue = raw;
  if (values["barrier-dir"]) {
    const directory = path.resolve(values["barrier-dir"]);
    mkdirSync(directory, { recursive: true });
    const name = label.slice(2);
    const startFile = path.join(directory, `${name}.start`);
    writeFileSync(path.join(directory, `${name}.${values.side}.ready`), "ready\n");
    const deadline = Date.now() + 2 * 60 * 60_000;
    while (!existsSync(startFile)) {
      assert(Date.now() < deadline, `${label} barrier timed out`);
      await delay(100);
    }
    startValue = readFileSync(startFile, "utf8").trim();
  }
  if (!startValue) {
    return;
  }
  const wait = integer(startValue, label) - Date.now();
  assert(wait > 0, `preparation missed ${label}`);
  await delay(wait);
}
try {
  const readyDeadline = Date.now() + 120_000;
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    await response.arrayBuffer();
    if (response.ok) {
      break;
    }
    assert(Date.now() < readyDeadline, "Gateway readiness timed out");
    await delay(250);
  }
  const sender = await connect(emails[0]!, -1);
  const viewers: ReturnType<typeof createGatewayWsClient>[] = [];
  for (let index = 0; index < clients; index++) {
    viewers.push(await connect(emails[1]!, index));
  }
  const self = await rpc(viewers[0]!, "users.self", {});
  assert(isRecord(self.profile) && typeof self.profile.id === "string");
  const recipientId = self.profile.id;
  await rpc(viewers[0]!, "users.setDisplayName", { profileId: recipientId, displayName: "Bob" });
  const keys: string[] = [];
  for (let index = 0; index < Math.min(10, mentions); index++) {
    const created = await rpc(sender, "sessions.create", {
      key: `agent:main:mention-bench-${index}`,
      visibility: "shared",
      displayName: `Synthetic mention ${index}`,
    });
    assert(typeof created.key === "string");
    keys.push(created.key);
  }
  for (let index = 0; index < mentions; index++) {
    const sent = await rpc(sender, "chat.send", {
      sessionKey: keys[index % keys.length],
      message: `@Bob Review synthetic item ${index}.`,
      idempotencyKey: `mention-seed-${index}`,
      mentions: [{ profileId: recipientId, start: 0, end: 4 }],
    });
    assert(typeof sent.runId === "string");
    const settled = await rpc(sender, "agent.wait", { runId: sent.runId, timeoutMs: 60_000 });
    assert.equal(settled.status, "ok", JSON.stringify(settled));
  }
  async function list(peer = viewers[0]!) {
    const result = await rpc(peer, "mentions.list", {});
    assert(
      Array.isArray(result.items) && result.items.length === mentions,
      `expected ${mentions} mentions, got ${JSON.stringify(result)}`,
    );
    return result;
  }
  for (const peer of viewers) {
    await list(peer);
  }
  assert(modelRequests >= mentions, "every seeded turn must reach the loopback model");
  assert.deepEqual(hooks.toSorted(), [
    "currentTarget",
    "readTarget",
    "readView",
    "shareSidebarSessionRows",
  ]);
  const sidebarViewers: SessionRequestClient[] = viewers.map((peer) => ({
    async request<T>(method: string, params?: unknown): Promise<T> {
      const result = await peer.request(method, params, 120_000);
      assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
      if (method === "sessions.list") {
        assert(isRecord(result.payload));
        counts[
          result.payload.rowsUnchanged
            ? "sidebarUnchanged"
            : result.payload.rowsDelta
              ? "sidebarDelta"
              : "sidebarFull"
        ]++;
      }
      return result.payload as T;
    },
  }));
  async function refreshSidebars(label?: string) {
    if (!sidebarLimit) {
      return;
    }
    await Promise.all(
      sidebarViewers.map(async (peer) => {
        const result = await requestSessionListParams(
          peer,
          { rowMode: "sidebar", source: "sidebar", limit: sidebarLimit, archived: "all" },
          () => true,
        );
        assert(result && result.sessions.length === sidebarLimit, "incomplete sidebar");
        const selected = result.sessions.find((row) => row.key === keys[0]);
        assert(selected, "changed mention session is missing from the sidebar");
        if (label !== undefined) {
          assert.equal(selected.label, label, "sidebar did not observe the current broadcast");
        }
      }),
    );
  }
  await refreshSidebars();
  await delay(250);
  resetCounts();
  await list();
  const singleListCounts = { ...counts };
  let patchSequence = 0;
  async function broadcast() {
    const before = viewers.map((_, index) => changedByViewer.get(index) ?? 0);
    const delivered = () =>
      before.every((count, index) => (changedByViewer.get(index) ?? 0) > count);
    await rpc(sender, "sessions.patch", {
      key: keys[0],
      label: `Synthetic revision ${++patchSequence}`,
    });
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (delivered()) {
        break;
      }
      await delay(5);
    }
    assert(delivered(), "mention title change did not reach every viewer");
    await refreshSidebars(`Synthetic revision ${patchSequence}`);
  }
  resetCounts();
  await broadcast();
  const singleBroadcastCounts = { ...counts };
  async function verifyTitle() {
    const result = await list();
    assert(Array.isArray(result.items));
    const selected = result.items.filter(
      (item: unknown) => isRecord(item) && item.sessionKey === keys[0],
    );
    assert(selected.length > 0);
    for (const item of selected) {
      assert(isRecord(item));
      assert.equal(item.sessionTitle, `Synthetic revision ${patchSequence}`);
    }
  }
  await verifyTitle();
  async function run(kind: "list" | "broadcast", count: number) {
    const latencies: number[] = [];
    for (let index = 0; index < count; index++) {
      const started = performance.now();
      if (kind === "list") {
        await list(viewers[index % viewers.length]);
      } else {
        await broadcast();
      }
      latencies.push(performance.now() - started);
    }
    return latencies;
  }
  console.log(
    JSON.stringify({
      phase: "ready",
      mentions,
      clients,
      sidebarLimit,
      singleListCounts,
      singleBroadcastCounts,
    }),
  );
  const measurements: Record<string, unknown> = {};
  const measuredModelRequests = modelRequests;
  if (!values["count-only"]) {
    assert(global.gc, "run with --expose-gc");
    inspector.connect();
    await run("list", 100);
    for (const kind of ["list", "broadcast"] as const) {
      const count = kind === "list" ? operations : broadcasts;
      const startOption = kind === "list" ? "start-at" : "broadcast-allocation-start-at";
      global.gc();
      await waitStart(values[startOption], `--${startOption}`);
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      resetCounts();
      const allocatedAt = Date.now();
      await run(kind, count);
      const allocationElapsedMs = Date.now() - allocatedAt;
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const profilePath = `${values.output}${kind === "list" ? "" : ".broadcast"}.heapprofile`;
      writeFileSync(profilePath, JSON.stringify(profile));
      let totalBytes = 0;
      const ownerBytes = { readTarget: 0, readView: 0, shareSidebarSessionRows: 0 };
      function visit(node: HeapProfiler.SamplingHeapProfileNode, owners: string[] = []) {
        const name = node.callFrame.functionName;
        const active = Object.hasOwn(ownerBytes, name) ? [...owners, name] : owners;
        totalBytes += node.selfSize;
        for (const owner of Object.keys(ownerBytes) as Array<keyof typeof ownerBytes>) {
          if (active.includes(owner)) {
            ownerBytes[owner] += node.selfSize;
          }
        }
        for (const child of node.children) {
          visit(child, active);
        }
      }
      visit(profile.head);
      measurements[kind === "list" ? "allocation" : "broadcastAllocation"] = {
        startedAt: allocatedAt,
        elapsedMs: allocationElapsedMs,
        operations: count,
        totalBytes,
        ownerBytes,
        bytesPerOperation: totalBytes / count,
        ...(kind === "list"
          ? {
              targetBytes: ownerBytes.readTarget,
              bytesPerRead: totalBytes / count,
              targetBytesPerRead: ownerBytes.readTarget / count,
              bytesPer450Reads: (totalBytes * 450) / count,
            }
          : {
              bytesPerBroadcast: totalBytes / count,
              bytesPerConnectedViewer: totalBytes / count / clients,
            }),
        measuredOperationsPerMinute: (count * 60_000) / allocationElapsedMs,
        estimatedBytesPerMinute: (totalBytes * 60_000) / allocationElapsedMs,
        counts: { ...counts },
      };
    }
    global.gc();
    await waitStart(values["cpu-start-at"], "--cpu-start-at");
    for (const kind of ["list", "broadcast"] as const) {
      if (kind === "broadcast") {
        await waitStart(values["broadcast-start-at"], "--broadcast-start-at");
      }
      const count = kind === "list" ? operations : broadcasts;
      const gc: Record<string, number[]> = { minor: [], major: [], other: [] };
      let start = Infinity;
      let end = Infinity;
      const record = (entries: PerformanceEntry[]) => {
        for (const entry of entries) {
          if (entry.startTime < start || entry.startTime > end) {
            continue;
          }
          const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
          gc[
            detail.kind === constants.NODE_PERFORMANCE_GC_MINOR
              ? "minor"
              : detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR
                ? "major"
                : "other"
          ]!.push(entry.duration);
        }
      };
      const observer = new PerformanceObserver((events) => record(events.getEntries()));
      observer.observe({ entryTypes: ["gc"] });
      const loop = monitorEventLoopDelay({ resolution: 1 });
      loop.enable();
      resetCounts();
      const before = process.cpuUsage();
      const threadBefore = process.threadCpuUsage();
      const startedAt = Date.now();
      markGc("diagnostics-start", `${values.output}.${kind}`);
      start = performance.now();
      const latencies = await run(kind, count);
      end = performance.now();
      markGc("diagnostics-stop", `${values.output}.${kind}`);
      const cpu = process.cpuUsage(before);
      const threadCpu = process.threadCpuUsage(threadBefore);
      loop.disable();
      await delay(10);
      record(observer.takeRecords());
      observer.disconnect();
      const elapsedMs = end - start;
      const totalGcMs = Object.values(gc)
        .flat()
        .reduce((sum, value) => sum + value, 0);
      measurements[kind] = {
        startedAt,
        operations: count,
        ...(values["trace-log"]
          ? {
              promotion: readGatewayGcTrace(
                values["trace-log"],
                `${values.output}.${kind}`,
                "diagnostics",
              ),
            }
          : {}),
        elapsedMs,
        cpuUs: cpu.user + cpu.system,
        cpuUsPerOperation: (cpu.user + cpu.system) / count,
        mainCpuUs: threadCpu.user + threadCpu.system,
        mainCpuUsPerOperation: (threadCpu.user + threadCpu.system) / count,
        cpuUsPerMinute: ((cpu.user + cpu.system) * 60_000) / elapsedMs,
        counts: { ...counts },
        latency: tails(latencies),
        loop: {
          samples: loop.count,
          p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
          maxMs: loop.count ? loop.max / 1e6 : null,
        },
        gc: {
          totalMs: totalGcMs,
          msPerOperation: totalGcMs / count,
          kinds: Object.fromEntries(
            Object.entries(gc).map(([name, pauses]) => [
              name,
              { totalMs: pauses.reduce((sum, value) => sum + value, 0), ...tails(pauses) },
            ]),
          ),
        },
      };
    }
  }
  await verifyTitle();
  assert.equal(
    modelRequests,
    measuredModelRequests,
    "loopback provider work entered measurement windows",
  );
  const report = {
    node: process.version,
    fixture: fixture.summary,
    mentions,
    clients,
    sidebarLimit,
    modelRequests,
    hooks,
    singleListCounts,
    singleBroadcastCounts,
    measurements,
  };
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  inspector.disconnect();
  for (const peer of peers) {
    peer.close();
  }
  await server.close({ reason: "synthetic mention benchmark complete" });
  await new Promise<void>((resolve) => {
    model.close(() => resolve());
  });
}
