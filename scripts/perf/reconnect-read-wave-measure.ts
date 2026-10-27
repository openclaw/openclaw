// Build the Gateway first (pnpm build); this measures dist/entry.js, never a dev server.
// Synthetic state only. Run with node --enable-source-maps --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session as InspectorSession } from "node:inspector/promises";
import { findSourceMap } from "node:module";
import { availableParallelism, loadavg, totalmem } from "node:os";
import path from "node:path";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  constants,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { resolveModelCatalogConnect } from "../../packages/gateway-client/src/model-catalog-connect.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../src/version.ts";
import { toErrorObject } from "../lib/error-format.mts";
import { stopChild, stopGatewayGracefully } from "../lib/gateway-bench-child.ts";
import {
  createGatewayBenchEnv,
  buildGatewayBenchChildArgs,
  summarizeNumbers,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const observerArgs: unknown = JSON.parse(
  new URL(import.meta.url).searchParams.get("args") ?? "null",
);
assert(
  observerArgs === null ||
    (Array.isArray(observerArgs) && observerArgs.every((value) => typeof value === "string")),
);
const { values } = parseArgs({
  ...(observerArgs === null ? {} : { args: observerArgs }),
  options: {
    root: { type: "string" },
    output: { type: "string" },
    clients: { type: "string", default: "65" },
    port: { type: "string", default: "41669" },
    sync: { type: "string" },
    side: { type: "string" },
    retention: { type: "boolean", default: false },
    entry: { type: "string", default: "dist/entry.js" },
  },
});
assert(values.root && values.output, "--root (generated team-shape fixture) and --output required");
const root = path.resolve(values.root);
const output = path.resolve(values.output);
const entry = path.resolve(values.entry);
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40000);
assert(port <= 65535, "use an isolated loopback port >=40000");
assert(
  !values.sync || values.side === "base" || values.side === "fix",
  "paired sync needs --side base|fix",
);
const clientCount = integer(values.clients, "--clients", 1);
assert(clientCount <= 256, "--clients is bounded at 256");
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
assert(
  isRecord(fixture) && fixture.format === "openclaw-team-shape-v1",
  "generated fixture required",
);
assert(typeof fixture.sessionCount === "number" && fixture.sessionCount >= clientCount);
const token = "synthetic-reconnect-read-wave-token";
const configPath = path.join(output, "openclaw.json");
const timeoutMs = 120_000;
const wireSamples: Array<{
  window: string;
  method: string;
  ms: number;
  ok: boolean;
  error?: unknown;
}> = [];
type Peer = ReturnType<typeof createGatewayWsClient>;

if (observerArgs !== null) {
  await observeGateway();
} else {
  await runController();
}

async function observeGateway() {
  assert(
    process.send && process.env.OPENCLAW_STATE_DIR === root,
    "private benchmark child required",
  );
  writeFileSync(path.join(output, "gateway.pid"), `${process.pid}\n`);
  // The existing IPC profiler tracks workers without exposing a debug listener or product RPC.
  await import("../lib/gateway-bench-profile-preload.ts");
  const { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
    await import("../../src/infra/diagnostic-events.ts");
  const { getTrackedWorkerPoolSnapshot, sampleTrackedWorkerMemory } =
    await import("../../src/infra/worker-cpu.ts");
  const started = performance.now();
  const allocationSampler = new InspectorSession();
  let sampling = false;
  if (values.retention) {
    allocationSampler.connect();
  }
  let window = "startup";
  const probe = () => Reflect.get(globalThis, "sessionRowChurnProbe");
  const retained = async (point: string, label: string) => {
    assert(values.retention && sampling);
    if (point === "settled" || point === "subscribed") {
      await allocationSampler.post("HeapProfiler.collectGarbage");
      await nextTurn();
      await allocationSampler.post("HeapProfiler.collectGarbage");
    }
    const retainedMemory = process.memoryUsage();
    const retainedHeap = getHeapStatistics();
    const retainedPresentations = probe()?.live();
    const retainedMeasurements = probe()?.snapshot();
    const { profile } = await allocationSampler.post("HeapProfiler.getSamplingProfile");
    writeFileSync(path.join(output, `${label}-${point}.heapprofile`), JSON.stringify(profile));
    const families = {
      presentSelectionConsume: 0,
      indexTrim: 0,
      shareSidebar: 0,
      catalogEntriesForCatalog: 0,
      catalogEntriesForAgent: 0,
      selectionSelf: 0,
      presentSnapshot: 0,
      freezePresent: 0,
      probeOverhead: 0,
      other: 0,
    };
    const sites: Array<{ bytes: number; stack: string[] }> = [];
    let total = 0;
    const visit = (
      node: HeapProfiler.SamplingHeapProfileNode,
      parents: Array<{ name: string; file: string }>,
    ) => {
      const map = findSourceMap(node.callFrame.url)?.findEntry(
        node.callFrame.lineNumber,
        node.callFrame.columnNumber,
      );
      const file =
        map && "originalSource" in map && map.originalSource
          ? map.originalSource
          : node.callFrame.url;
      if (map && "originalSource" in map && map.originalSource) {
        node.callFrame.url = file;
        node.callFrame.lineNumber = map.originalLine;
        node.callFrame.columnNumber = map.originalColumn;
      }
      const stack = [...parents, { name: node.callFrame.functionName, file }];
      const has = (name: string, filename?: string) =>
        stack.some((f) => f.name.includes(name) && (!filename || f.file.includes(filename)));
      const allocationOwner = stack
        .toReversed()
        .find((f) => f.file && !f.file.startsWith("node:") && !f.file.includes("internal/"));
      const probeAllocation =
        allocationOwner?.file.includes("session-row-churn-probe") ||
        allocationOwner?.file.includes("reconnect-read-wave-");
      const matching: Array<keyof typeof families> = [];
      if (
        has("present", "session-row-presentation") &&
        has("consumeCurrent", "session-row-prepared-read") &&
        stack.some((f) => f.file.includes("session-utils-list"))
      ) {
        matching.push("presentSelectionConsume");
      }
      if (has("indexSessionRow") && has("trim", "session-row-projection")) {
        matching.push("indexTrim");
      }
      if (has("share") && has("shareSidebarSessionRows")) {
        matching.push("shareSidebar");
      }
      if (has("entriesForCatalog")) {
        matching.push("catalogEntriesForCatalog");
      }
      if (has("entriesForAgent")) {
        matching.push("catalogEntriesForAgent");
      }
      if (has("present") && has("snapshot")) {
        matching.push("presentSnapshot");
      }
      if (has("freezeTrustedJsonSnapshot") && has("present")) {
        matching.push("freezePresent");
      }
      if (
        node.callFrame.functionName.includes("selection") &&
        file.includes("session-utils-list")
      ) {
        matching.push("selectionSelf");
      }
      if (probeAllocation) {
        matching.length = 0;
        matching.push("probeOverhead");
      }
      if (!matching.length) {
        matching.push("other");
      }
      for (const family of matching) {
        families[family] += node.selfSize;
      }
      total += node.selfSize;
      if (node.selfSize) {
        sites.push({ bytes: node.selfSize, stack: stack.map((f) => `${f.name} (${f.file})`) });
      }
      for (const child of node.children) {
        visit(child, stack);
      }
    };
    visit(profile.head, []);
    writeFileSync(
      path.join(output, `${label}-${point}.sourcemapped.heapprofile`),
      JSON.stringify(profile),
    );
    writeFileSync(
      path.join(output, `${label}-${point}-retention.json`),
      JSON.stringify(
        {
          window: label,
          point,
          samplingIntervalBytes: 32768,
          includesCollectedObjects: false,
          scope:
            "main-isolate V8 sampled surviving allocations; native/external bytes are not attributed; stack families are inclusive and may overlap",
          sampledSurvivingBytes: total,
          families,
          memory: retainedMemory,
          heap: retainedHeap,
          presentations: retainedPresentations,
          measurements: retainedMeasurements,
          topSites: sites.toSorted((a, b) => b.bytes - a.bytes).slice(0, 100),
        },
        null,
        2,
      ),
    );
    assert(
      probe()?.snapshot().search.staticFactChanges === 0,
      "churn workload changed static search facts",
    );
  };
  let dropped = 0;
  const events: Array<Record<string, unknown>> = [];
  const resources: Array<Record<string, unknown>> = [];
  const record = (source: string, raw: unknown) => {
    if (!isRecord(raw)) {
      return;
    }
    if (events.length >= 100_000) {
      dropped++;
      return;
    }
    const event: Record<string, unknown> = { source, window, atMs: performance.now() - started };
    for (const key of [
      "method",
      "operation",
      "phase",
      "outcome",
      "kind",
      "requestClass",
      "workerClass",
      "script",
      "worker",
      "firstResponse",
      "durationMs",
      "queueWaitMs",
      "admissionMs",
      "responseBytes",
      "threadCpuMs",
      "queueMs",
      "preparationMs",
      "hostWaitMs",
      "runMs",
      "transferMs",
      "pendingTasks",
      "pendingBytes",
      "prepareThreadCpuMs",
      "rowThreadCpuMs",
      "responseThreadCpuMs",
      "prepareSyncMs",
      "rowSyncMs",
      "yieldWaitMs",
      "selectedRowCount",
      "materializedRowCount",
      "reusedRowCount",
      "queueDepth",
      "activeTasks",
      "workers",
      "maxWorkers",
      "workersCreated",
    ]) {
      const value = raw[key];
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        event[key] = value;
      }
    }
    events.push(event);
  };
  const channels = ["openclaw.gateway.rpc", "openclaw.worker.task", "openclaw.session.list"].map(
    (name) => {
      const source = channel(name);
      const listener = (event: unknown) => record(name, event);
      source.subscribe(listener);
      return () => source.unsubscribe(listener);
    },
  );
  const unsubscribe = onInternalDiagnosticEvent((event) => record("worker.request", event), {
    include: ["worker.request"],
  });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let gcStart = Infinity,
    gcEnd = Infinity;
  let gcSamples: Array<{ kind: number; durationMs: number }> = [];
  const collectGc = (entries: ReturnType<PerformanceObserver["takeRecords"]>) => {
    for (const event of entries) {
      if (event.startTime >= gcStart && event.startTime <= gcEnd) {
        const detail = (event as PerformanceEntry & { detail: { kind: number } }).detail;
        gcSamples.push({ kind: detail.kind, durationMs: event.duration });
      }
    }
  };
  const gcObserver = new PerformanceObserver((list) => collectGc(list.getEntries()));
  gcObserver.observe({ entryTypes: ["gc"] });
  const gcReport = () => {
    const summarize = (samples: typeof gcSamples) => {
      const durations = samples.map((s) => s.durationMs).toSorted((a, b) => a - b);
      const tail = (p: number) =>
        durations[Math.max(0, Math.ceil(durations.length * p) - 1)] ?? null;
      return {
        count: durations.length,
        totalMs: durations.reduce((n, d) => n + d, 0),
        maxMs: durations.at(-1) ?? 0,
        p95Ms: tail(0.95),
        p99Ms: tail(0.99),
      };
    };
    return {
      scope: "main isolate, untraced PerformanceObserver",
      ...summarize(gcSamples),
      byKind: Object.fromEntries(
        Object.entries({
          minor: constants.NODE_PERFORMANCE_GC_MINOR,
          major: constants.NODE_PERFORMANCE_GC_MAJOR,
          incremental: constants.NODE_PERFORMANCE_GC_INCREMENTAL,
          weak: constants.NODE_PERFORMANCE_GC_WEAKCB,
        }).map(([name, kind]) => [name, summarize(gcSamples.filter((s) => s.kind === kind))]),
      ),
    };
  };
  let beforeCpu = process.threadCpuUsage();
  let beforeProcessCpu = process.cpuUsage();
  let beforeElu = performance.eventLoopUtilization();
  const sample = () => {
    if (resources.length < 10_000) {
      resources.push({
        window,
        atMs: performance.now() - started,
        rssBytes: process.memoryUsage.rss(),
        pools: getTrackedWorkerPoolSnapshot(),
        workers: sampleTrackedWorkerMemory(),
      });
    }
  };
  const sampler = setInterval(sample, 100);
  sampler.unref();
  sample();
  const host = {
    pid: process.pid,
    availableParallelism: availableParallelism(),
    totalmem: totalmem(),
    constrainedMemory: process.constrainedMemory(),
    loadavg: loadavg(),
    node: process.version,
  };
  let queue = Promise.resolve();
  process.on("message", (raw: unknown) => {
    if (!isRecord(raw) || raw.channel !== "reconnect-wave" || typeof raw.id !== "string") {
      return;
    }
    const control = raw;
    queue = queue
      .then(async () => {
        if (control.action === "begin") {
          window = String(control.window);
          probe()?.begin(window, values.retention);
          if (values.retention && !sampling) {
            await allocationSampler.post("HeapProfiler.startSampling", {
              samplingInterval: 32768,
              includeObjectsCollectedByMajorGC: false,
              includeObjectsCollectedByMinorGC: false,
            });
            sampling = true;
          }
          gcSamples = [];
          gcStart = performance.now();
          gcEnd = Infinity;
          loop.reset();
          loop.enable();
          beforeCpu = process.threadCpuUsage();
          beforeProcessCpu = process.cpuUsage();
          beforeElu = performance.eventLoopUtilization();
          sample();
        } else if (control.action === "end") {
          await waitForDiagnosticEventsDrained();
          sample();
          loop.disable();
          gcEnd = performance.now();
          collectGc(gcObserver.takeRecords());
          const measuredCpu = process.threadCpuUsage(beforeCpu);
          const measuredProcessCpu = process.cpuUsage(beforeProcessCpu);
          writeFileSync(
            path.join(output, `${window}-server.json`),
            JSON.stringify(
              {
                host,
                window,
                measurements: probe()?.snapshot(),
                dropped,
                mainThreadCpu: measuredCpu,
                processCpu: measuredProcessCpu,
                elapsedMs: gcEnd - gcStart,
                gc: gcReport(),
                eventLoop: {
                  count: loop.count,
                  p95Ms: loop.percentile(95) / 1e6,
                  p99Ms: loop.percentile(99) / 1e6,
                  maxMs: loop.max / 1e6,
                  utilization: performance.eventLoopUtilization(beforeElu),
                },
                events: events.filter((event) => event.window === window),
                resources: resources.filter((resource) => resource.window === window),
              },
              null,
              2,
            ),
          );
          if (window.startsWith("wave-")) {
            for (const source of [
              "openclaw.gateway.rpc",
              "openclaw.worker.task",
              "worker.request",
            ]) {
              assert(
                events.some((event) => event.window === window && event.source === source),
                `${source} diagnostics were not captured`,
              );
            }
          }
          window = "idle";
        } else if (control.action === "retain") {
          await retained(String(control.point), String(control.window));
        } else if (control.action === "stop") {
          if (sampling) {
            await allocationSampler.post("HeapProfiler.stopSampling");
            sampling = false;
            allocationSampler.disconnect();
          }
          gcObserver.disconnect();
          clearInterval(sampler);
          loop.disable();
          unsubscribe();
          for (const unsubscribeChannel of channels) {
            unsubscribeChannel();
          }
        }
        process.send?.({ channel: "reconnect-wave", id: control.id });
      })
      .catch((error: unknown) => {
        process.send?.({ channel: "reconnect-wave", id: control.id, error: String(error) });
      });
  });
  process.channel?.unref();
  // An awaited probe in a preload would prevent the CLI entry from starting.
  void waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: started,
    deadlineAt: performance.now() + timeoutMs,
  }).then(
    (ready) => {
      process.send?.({
        channel: "reconnect-wave",
        id: "ready",
        host,
        ...(ready.status === 200
          ? {}
          : { error: "Gateway recovery admission did not become ready" }),
      });
    },
    (error: unknown) => {
      process.send?.({ channel: "reconnect-wave", id: "ready", error: String(error) });
    },
  );
}

async function rpc(peer: Peer, method: string, params: unknown, window: string) {
  const started = performance.now();
  let recorded = false;
  try {
    const response = await peer.request(method, params, timeoutMs);
    wireSamples.push({
      window,
      method,
      ms: performance.now() - started,
      ok: response.ok,
      ...(!response.ok ? { error: response.error } : {}),
    });
    recorded = true;
    assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
    return response.payload;
  } catch (error) {
    if (!recorded) {
      wireSamples.push({
        window,
        method,
        ms: performance.now() - started,
        ok: false,
        error: String(error),
      });
    }
    throw error;
  }
}

async function runController() {
  assert(existsSync(entry), `Build the Gateway CLI before measuring: ${entry}`);
  const buildId = readBuildIdFromBuildInfoForModuleUrl(pathToFileURL(entry).href);
  assert(buildId, "Compiled Gateway build identity required");
  mkdirSync(output, { recursive: false });
  const cfg: OpenClawConfig = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
  cfg.gateway = {
    ...cfg.gateway,
    port,
    auth: { mode: "token", token },
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  };
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  cfg.agents = {
    ...cfg.agents,
    defaults: { ...cfg.agents?.defaults, model: "openai/gpt-4.1" },
  };
  writeFileSync(configPath, JSON.stringify(cfg));
  const devices = Array.from({ length: clientCount + 1 }, () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      pair.publicKey.export({ type: "spki", format: "pem" }),
    );
    return {
      publicKey,
      id: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    };
  });
  const peers = new Set<Peer>();
  const writers = new Set<Peer>();
  const writerLifetimes = new Set<AbortController>();
  const catalogs = new WeakMap<Peer, Promise<void>>();
  let child: ChildProcess | undefined;
  const launch = async (label: string) => {
    const log = createWriteStream(path.join(output, `${label}.log`));
    const observer = new URL(import.meta.url);
    observer.searchParams.set(
      "args",
      JSON.stringify([
        "--root",
        root,
        "--output",
        output,
        "--port",
        String(port),
        "--clients",
        String(clientCount),
        "--entry",
        entry,
        ...(values.retention ? ["--retention"] : []),
      ]),
    );
    const stopPreload = new URL("../lib/gateway-bench-stop-preload.mjs", import.meta.url);
    stopPreload.searchParams.set("parentPid", String(process.pid));
    stopPreload.searchParams.set("entry", entry);
    child = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(
        entry,
        port,
        [...process.execArgv, "--import", observer.href, "--import", stopPreload.href],
        "token",
      ),
      {
        env: createGatewayBenchEnv(path.join(root, "home"), configPath, {
          startupTrace: false,
          caseEnv: {
            OPENCLAW_STATE_DIR: root,
            TMPDIR: path.join(root, "tmp"),
            OPENCLAW_SKIP_CHANNELS: "1",
          },
        }),
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.once("close", () => log.end());
    await waitReply(child, "ready");
    return child;
  };
  const connect = async (index: number, window: string) => {
    const challenge = Promise.withResolvers<{
      nonce: string;
      ts: number;
      capabilities: string[];
    }>();
    const catalog = Promise.withResolvers<void>();
    const peer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      openTimeoutMs: timeoutMs,
      handshakeTimeoutMs: timeoutMs,
      onEvent(event) {
        if (
          event.event === "connect.challenge" &&
          isRecord(event.payload) &&
          typeof event.payload.nonce === "string" &&
          typeof event.payload.ts === "number"
        ) {
          challenge.resolve({
            nonce: event.payload.nonce,
            ts: event.payload.ts,
            capabilities: Array.isArray(event.payload.capabilities)
              ? event.payload.capabilities.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
          });
        } else if (event.event === "models.snapshot") {
          catalog.resolve();
        }
      },
    });
    peers.add(peer);
    await peer.waitOpen();
    const challengeTimer = setTimeout(
      () => challenge.reject(new Error("connect challenge timeout")),
      timeoutMs,
    );
    let signed: Awaited<typeof challenge.promise>;
    try {
      signed = await challenge.promise;
    } finally {
      clearTimeout(challengeTimer);
    }
    const device = devices[index]!;
    const scopes = [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
    ];
    const client = {
      id: "openclaw-control-ui",
      version: "synthetic",
      buildId,
      platform: "web",
      mode: "webchat",
      instanceId: `synthetic-reconnect-${index}`,
    };
    const payload = buildDeviceAuthPayloadV3({
      deviceId: device.id,
      clientId: client.id,
      clientMode: client.mode,
      platform: client.platform,
      role: "operator",
      scopes,
      signedAtMs: signed.ts,
      token,
      nonce: signed.nonce,
    });
    const modelCatalogConnect = resolveModelCatalogConnect({
      serverCapabilities: signed.capabilities,
      modelCatalog: { agentId: "main", sessionKey: `agent:main:team-shape-session-${index}` },
      caps: [
        "agent-kind",
        "approvals",
        "task-suggestions",
        "terminal-offset-seq",
        "terminal-session-metadata",
        "terminal-upload-path-style",
        "tool-events",
        "chat-only-assistant-text",
        "hello-health-on-demand",
        "health-summary",
        "hello-presence-self",
        "session-scoped-events",
        "presence-deltas",
        "session-row-deltas",
        "session-event-field-refs",
        "roster-message-bodies-optional",
        "inline-widgets",
        "model-selection-policy",
        "model-wait-status",
        "ui-commands",
        "ultrafast",
        "usage-refreshing",
      ],
    });
    if (modelCatalogConnect.modelCatalog) {
      catalogs.set(peer, catalog.promise);
    }
    const hello = await rpc(
      peer,
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "operator",
        scopes,
        auth: { token },
        ...modelCatalogConnect,
        device: {
          id: device.id,
          publicKey: device.publicKey,
          signedAt: signed.ts,
          nonce: signed.nonce,
          signature: signEd25519Payload(device.privateKey, payload),
        },
      },
      window,
    );
    assert(
      isRecord(hello) && isRecord(hello.auth) && Array.isArray(hello.auth.scopes),
      "operator auth missing",
    );
    const authorizedScopes = hello.auth.scopes;
    assert(
      scopes.every((scope) => authorizedScopes.includes(scope)),
      "operator scopes missing",
    );
    return peer;
  };
  const boot = async (peer: Peer, index: number, window: string) => {
    const key = `agent:main:team-shape-session-${index}`;
    const roster = rpc(peer, "sessions.subscribe", {}, window);
    const list = rpc(
      peer,
      "sessions.list",
      {
        agentId: "main",
        limit: 200,
        rowMode: "sidebar",
        source: "sidebar",
        configuredAgentsOnly: true,
        excludeDock: true,
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
      },
      window,
    );
    const subscribed = rpc(
      peer,
      "sessions.messages.subscribe",
      { key, includeApprovals: true, subscriptionId: randomUUID() },
      window,
    );
    const catalog = catalogs.get(peer);
    let catalogTimer: ReturnType<typeof setTimeout> | undefined;
    const modelReady = catalog
      ? Promise.race([
          catalog,
          new Promise<never>((_, reject) => {
            catalogTimer = setTimeout(
              () => reject(new Error("models.snapshot timeout")),
              timeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(catalogTimer))
      : rpc(peer, "models.list", { agentId: "main", sessionKey: key, view: "configured" }, window);
    const results = await Promise.allSettled([
      roster,
      list,
      subscribed,
      rpc(peer, "sessions.observer.visibility", { visible: true }, window),
      rpc(peer, "sessions.resolve", { key, agentId: "main" }, window),
      rpc(peer, "board.get", { sessionKey: key, agentId: "main" }, window),
      rpc(peer, "agents.list", {}, window),
      rpc(peer, "users.list", {}, window),
      modelReady,
      subscribed.then(() => rpc(peer, "chat.startup", { sessionKey: key, limit: 80 }, window)),
    ]);
    return results.every((result) => result.status === "fulfilled");
  };
  const closePeers = async () => {
    await Promise.all(
      [...peers].map(
        (peer) =>
          new Promise<void>((resolve) => {
            if (peer.ws.readyState === peer.ws.CLOSED) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              peer.ws.terminate();
              resolve();
            }, 10_000);
            peer.ws.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            peer.close();
          }),
      ),
    );
    peers.clear();
  };
  try {
    // Pair devices and seed boards outside the measured process, then restart with all workers cold.
    await launch("pairing");
    for (let index = 0; index <= clientCount; index++) {
      const peer = await connect(index, "setup");
      if (index < clientCount) {
        await rpc(
          peer,
          "board.widget.put",
          {
            sessionKey: `agent:main:team-shape-session-${index}`,
            name: "synthetic-wave-chart",
            title: "Synthetic wave chart",
            content: {
              kind: "html",
              html: "<!doctype html><title>Synthetic chart</title><p>42</p>",
            },
          },
          "setup",
        );
      }
      peer.close();
      peers.delete(peer);
    }
    await command(child!, { action: "stop" });
    await stopGatewayGracefully(child!, timeoutMs);
    child = undefined;
    const gateway = await launch("measured");
    const waveReports: Array<Record<string, unknown>> = [];
    const writerKeys = Array.from({ length: 250 }, (_, i) => i)
      .filter((i) => i % 5 !== 0)
      .map((i) => `agent:main:team-shape-session-${i}`);
    assert(writerKeys.length === 200);
    for (let wave = 0; wave < (values.retention ? 5 : 1); wave++) {
      const label = `wave-${wave}`;
      const writer = await connect(clientCount, `${label}:writer-setup`);
      peers.delete(writer);
      writers.add(writer);
      const writerLifetime = new AbortController();
      writerLifetimes.add(writerLifetime);
      let submitted = 0,
        completed = 0;
      let writerError: unknown;
      const writes: Array<{
        index: number;
        key: string;
        submittedAtMs: number;
        completedAtMs: number;
        lagMs: number;
      }> = [];
      const progress = new Set<() => void>();
      const release = () => {
        const waiting = [...progress];
        progress.clear();
        for (const callback of waiting) {
          callback();
        }
      };
      const waitWritten = (count: number) =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            progress.delete(check);
            writerLifetime.signal.removeEventListener("abort", aborted);
            writer.ws.off("close", closed);
            if (error !== undefined) {
              reject(toErrorObject(error, "Writer failed"));
            } else {
              resolve();
            }
          };
          const check = () => {
            if (writerError !== undefined) {
              finish(writerError);
            } else if (completed >= count) {
              finish();
            } else {
              progress.add(check);
            }
          };
          const aborted = () =>
            finish(writerLifetime.signal.reason ?? new Error(`${label}: writer aborted`));
          const closed = () =>
            finish(
              new Error(
                `${label}: writer socket closed before ${count} committed writes (${completed}/${submitted})`,
              ),
            );
          const timer = setTimeout(
            () =>
              finish(
                new Error(
                  `${label}: timeout waiting for ${count} committed writes (${completed}/${submitted})`,
                ),
              ),
            timeoutMs,
          );
          writerLifetime.signal.addEventListener("abort", aborted, { once: true });
          writer.ws.once("close", closed);
          if (writerLifetime.signal.aborted) {
            aborted();
          } else {
            check();
          }
        });
      if (values.sync) {
        const prefix = `${path.resolve(values.sync)}.${label}`;
        writeFileSync(
          `${prefix}.${values.side}.ready`,
          JSON.stringify({ pid: process.pid, gatewayPid: gateway.pid, readyAt: Date.now() }),
        );
        const deadline = Date.now() + timeoutMs;
        while (!existsSync(`${prefix}.go`)) {
          assert(Date.now() < deadline, "paired wave start timed out");
          await delay(25);
        }
        const startAt = Number(readFileSync(`${prefix}.go`, "utf8"));
        assert(Number.isFinite(startAt) && startAt > Date.now(), "missed synchronized start");
        await delay(startAt - Date.now());
      }
      await command(gateway, { action: "begin", window: label });
      const at = performance.now();
      const pending: Promise<void>[] = [];
      const writing = (async () => {
        for (let index = 0; index < 200; index++) {
          const scheduled = at + index * 50;
          const remaining = scheduled - performance.now();
          if (remaining > 0) {
            await delay(remaining, undefined, { signal: writerLifetime.signal });
          }
          writerLifetime.signal.throwIfAborted();
          const submittedAtMs = performance.now() - at;
          submitted++;
          const key = writerKeys[index % 200]!;
          pending.push(
            rpc(
              writer,
              "chat.inject",
              {
                sessionKey: key,
                agentId: "main",
                message: `Synthetic timestamp churn wave ${wave} append ${index}`,
              },
              `${label}:writer`,
            )
              .then(() => {
                writes.push({
                  index,
                  key,
                  submittedAtMs,
                  completedAtMs: performance.now() - at,
                  lagMs: submittedAtMs - index * 50,
                });
                completed++;
                release();
              })
              .catch((error: unknown) => {
                writerError = error;
                release();
              }),
          );
        }
        await Promise.all(pending);
        if (writerError) {
          throw toErrorObject(writerError, "Writer failed");
        }
      })().catch((error: unknown) => {
        writerError = error;
        release();
        throw error;
      });
      // Observe rejection immediately; the final await below remains the verdict.
      void writing.catch(() => {});
      const connections = await Promise.allSettled(
        Array.from({ length: clientCount }, async (_, index) => {
          const peer = await connect(index, `${label}:cold`);
          return await boot(peer, index, `${label}:cold`);
        }),
      );
      assert(
        connections.every((result) => result.status === "fulfilled" && result.value),
        "incomplete cold wave",
      );
      const coldElapsedMs = performance.now() - at;
      const rounds: Array<Record<string, unknown>> = [];
      let previous = 0;
      for (let round = 0; round < 3; round++) {
        const threshold = Math.max([20, 80, 140][round]!, previous + 20);
        assert(threshold < 200, "search rounds missed the fixed writer window");
        await waitWritten(threshold);
        assert(completed < 200, "search must start while writer remains active");
        const before = completed;
        const roundAt = performance.now() - at;
        await Promise.all(
          [...peers].map(async (peer) => {
            await rpc(
              peer,
              "sessions.list",
              {
                agentId: "main",
                limit: 200,
                rowMode: "sidebar",
                source: "agent-roster",
                search: "team-shape",
                configuredAgentsOnly: true,
                excludeDock: true,
                includeGlobal: true,
                includeUnknown: true,
                includeDerivedTitles: true,
                includeLastMessage: true,
              },
              `${label}:search-${round + 1}`,
            );
          }),
        );
        rounds.push({
          round: round + 1,
          startedAtMs: roundAt,
          completedAtMs: performance.now() - at,
          writesBefore: before,
          writesAfter: completed,
        });
        previous = before;
      }
      await writing;
      assert(submitted === 200 && completed === 200);
      await command(gateway, { action: "end" });
      if (values.retention) {
        await command(gateway, { action: "retain", point: "subscribed", window: label });
      }
      peers.add(writer);
      await closePeers();
      writers.delete(writer);
      writerLifetimes.delete(writerLifetime);
      if (values.retention) {
        // Existing five-second shared-response retention is allowed to settle outside timings.
        await delay(5100);
        await command(gateway, { action: "retain", point: "settled", window: label });
      }
      waveReports.push({
        label,
        coldElapsedMs,
        elapsedMs: performance.now() - at,
        writes,
        rounds,
        submitted,
        completed,
      });
    }
    await command(gateway, { action: "begin", window: "steady" });
    const warm = await connect(0, "steady");
    const steadyComplete = await boot(warm, 0, "steady");
    await command(gateway, { action: "end" });
    const report = {
      entry,
      buildId,
      fixture,
      clientCount,
      waveReports,
      connectionsRejected: 0,
      clientsIncomplete: 0,
      steadyComplete,
      windows: Object.fromEntries(
        [...new Set(wireSamples.map((sample) => sample.window))].map((window) => [
          window,
          Object.fromEntries(
            [
              ...new Set(
                wireSamples.filter((row) => row.window === window).map((row) => row.method),
              ),
            ].map((method) => {
              const rows = wireSamples.filter(
                (row) => row.window === window && row.method === method,
              );
              return [
                method,
                {
                  ...summarizeNumbers(rows.map((row) => row.ms)),
                  p90: rows.map((row) => row.ms).toSorted((a, b) => a - b)[
                    Math.ceil(rows.length * 0.9) - 1
                  ],
                  errors: rows.filter((row) => !row.ok).length,
                },
              ];
            }),
          ),
        ]),
      ),
      wireSamples,
      limitations: [
        "worker.request labels identify worker kinds, not every pool instance; worker.task provides pool script/class",
        "RSS samples cover the Gateway process and its threads, excluding subprocess read workers; per-thread RSS is not independent",
        "RPC admissionMs combines preparation/auth/admission; CPU profiles and worker phases attribute the inner waits",
        "single warm boot is a smoke sample; compare independent fresh-process runs for statistical gates",
        "fixture is mutated by synthetic pairing/board seeding; use a fresh generated copy for each baseline/candidate run",
      ],
    };
    writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, wireSamples: undefined }, null, 2));
    await closePeers();
    await command(gateway, { action: "stop" });
    await stopGatewayGracefully(gateway, timeoutMs);
    child = undefined;
  } catch (error) {
    writeFileSync(
      path.join(output, "failure.json"),
      JSON.stringify({ error: String(error), wireSamples }, null, 2),
    );
    throw error;
  } finally {
    for (const lifetime of writerLifetimes) {
      lifetime.abort(new Error("Benchmark ended"));
    }
    for (const writer of writers) {
      peers.add(writer);
    }
    await closePeers();
    if (child) {
      await stopChild(child);
    }
  }
}

function waitReply(child: ChildProcess, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("disconnect", onExit);
      child.off("error", finish);
      if (error) {
        reject(toErrorObject(error, "Writer failed"));
      } else {
        resolve();
      }
    };
    const onMessage = (raw: unknown) => {
      if (isRecord(raw) && raw.channel === "reconnect-wave" && raw.id === id) {
        finish(raw.error ? toErrorObject(raw.error, "Gateway observer failed") : undefined);
      }
    };
    const onExit = () => finish(new Error(`Gateway exited waiting for ${id}`));
    const timer = setTimeout(() => finish(new Error(`Gateway IPC timeout: ${id}`)), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("disconnect", onExit);
    child.once("error", finish);
  });
}

async function command(child: ChildProcess, payload: Record<string, string>) {
  const id = `${payload.action}-${performance.now()}`;
  const reply = waitReply(child, id);
  child.send({ channel: "reconnect-wave", id, ...payload });
  await reply;
}
