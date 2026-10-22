import { readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8, { getHeapSpaceStatistics, queryObjects, writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";
import { getWorkerMessageMetrics } from "../../src/infra/worker-message-metrics.ts";
import { startGatewayBenchDiagnostics } from "./gateway-bench-diagnostics.ts";
import {
  GATEWAY_PROFILE_CHANNEL,
  GATEWAY_GC_TRACE_MARKER,
  GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  type GatewayBenchCommand,
  type GatewayProfileCommand,
  type GatewayCpuUsageSnapshot,
  type GatewayResourceSnapshot,
} from "./gateway-bench-profile.ts";
import { GatewayBenchWorkerProfiler } from "./gateway-bench-worker-profile.ts";

function sampleCpu(): GatewayCpuUsageSnapshot {
  return {
    pid: process.pid,
    cpuEnvironment: {
      availableParallelism: availableParallelism(),
      affinity:
        process.platform === "linux"
          ? readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/mu)?.[1]
          : undefined,
    },
    atMonotonicMicros: Number(process.hrtime.bigint() / 1_000n),
    process: process.cpuUsage(),
    mainThread: process.threadCpuUsage(),
  };
}

function sampleResources(): GatewayResourceSnapshot {
  const counts = new Map<string, number>();
  for (const type of process.getActiveResourcesInfo()) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return {
    ...sampleCpu(),
    memory: process.memoryUsage(),
    heapSpaces: getHeapSpaceStatistics(),
    // These resource types keep the event loop alive; they are not ownership IDs.
    activeResources: Object.fromEntries(
      [...counts].toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  };
}

// Only the benchmark child gets this preload and IPC descriptor. No inspector
// listener or profiler control is exposed through the Gateway protocol.
if (isMainThread) {
  if (!process.send) {
    throw new Error("Gateway profiling requires the benchmark IPC channel");
  }
  const broadcastTiming = process.env.OPENCLAW_BENCH_BROADCAST_TIMING === "1";
  const sessionProjectionSource = process.env.OPENCLAW_BENCH_SESSION_PROJECTION_SOURCE;
  let broadcastTimingInstalled = false;
  if (broadcastTiming || sessionProjectionSource) {
    const entry = new URL("../../src/entry.ts", import.meta.url);
    if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(entry)) {
      throw new Error(
        "Broadcast timing and session projection sources require --entry src/entry.ts",
      );
    }
    const projectionSources = new Map<string, string>();
    if (sessionProjectionSource) {
      for (const file of [
        "session-event-projection.ts",
        "session-row-presentation.ts",
        "session-sharing-read.ts",
        "session-utils-list.ts",
      ]) {
        projectionSources.set(
          new URL(`../../src/gateway/${file}`, import.meta.url).href,
          readFileSync(path.join(sessionProjectionSource, file), "utf8"),
        );
      }
    }
    const owner = new URL("../../src/gateway/server-broadcast.ts", import.meta.url).href;
    registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        const projectionSource = projectionSources.get(url);
        if (projectionSource !== undefined) {
          // Preserve canonical imports and original TypeScript lines in sampled stacks.
          return { ...loaded, format: "module-typescript", source: projectionSource };
        }
        if (url !== owner) {
          return loaded;
        }
        let source = readFileSync(new URL(url), "utf8");
        // Native source preserves the broadcaster's name in allocation profiles without a timer.
        if (!broadcastTiming) {
          return { ...loaded, format: "module-typescript", source };
        }
        const opening = "  ) => {\n    if (!retained) {";
        const closing = "\n  };\n\n  const broadcast: GatewayBroadcastFn";
        if (source.split(opening).length !== 2 || source.split(closing).length !== 2) {
          throw new Error("Broadcast timing source anchors changed; update the benchmark observer");
        }
        // Keep the original body and early returns; only numeric timing crosses this private channel.
        source = source
          .replace(
            opening,
            `  ) => {
    const benchmarkBroadcastStarted = benchmarkBroadcastChannel.hasSubscribers ? performance.now() : undefined;
    try {
    if (!retained) {`,
          )
          .replace(
            closing,
            `
    } finally {
      if (benchmarkBroadcastStarted !== undefined) {
        benchmarkBroadcastChannel.publish({ operation: event, durationMs: performance.now() - benchmarkBroadcastStarted });
      }
    }
  };

  const broadcast: GatewayBroadcastFn`,
          );
        source = `import { channel as benchmarkBroadcastDiagnosticChannel } from "node:diagnostics_channel";
const benchmarkBroadcastChannel = benchmarkBroadcastDiagnosticChannel("openclaw.benchmark.broadcast");
${source}`;
        broadcastTimingInstalled = true;
        return { ...loaded, format: "module-typescript", source };
      },
    });
  }
  if (process.env.OPENCLAW_BENCH_FIRST_TEXT === "1") {
    const { onAgentEvent } = await import("../../src/infra/agent-events.js");
    onAgentEvent((event) => {
      if (event.stream === "assistant" && (event.data.delta || event.data.text)) {
        process.send?.({
          channel: GATEWAY_PROFILE_CHANNEL,
          kind: "agent-text",
          runId: event.runId,
          atEpochMs: performance.timeOrigin + performance.now(),
        });
      }
    });
  }
  // This begins after preload imports, before the Gateway entry. It is not
  // process birth and does not include the profiler's own module import cost.
  const initialResources = sampleResources();
  const inspector = new Session();
  let workerMemoryModule: typeof import("../../src/infra/worker-cpu.ts") | undefined;
  const workers = new GatewayBenchWorkerProfiler(inspector, (threadId) => {
    // Retain registry identity before a short-lived worker disappears between resource samples.
    const memory = workerMemoryModule?.sampleTrackedWorkerMemory();
    if (!memory) {
      return undefined;
    }
    return (
      memory.workerHeaps.find((worker) => worker.threadId === threadId)?.script ??
      memory.workerMemoryMissing.find((worker) => worker.threadId === threadId)?.script ??
      null
    );
  });
  let inspectorConnected = false;
  const traceGc = process.execArgv.includes("--trace-gc-nvp");
  const markGc = (phase: string, profilePath?: string) => {
    if (traceGc) {
      // Share V8's stdout descriptor without asynchronous stream buffering.
      writeSync(
        1,
        `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
      );
    }
  };
  if (traceGc) {
    inspector.connect();
    inspectorConnected = true;
    // The preload runs before Gateway entry and its workers. Identify V8's
    // main-isolate address with a forced GC outside every measured capture.
    markGc("identify-start");
    await inspector.post("HeapProfiler.collectGarbage");
    markGc("identify-stop");
  }
  const active = new Set<GatewayProfileCommand["kind"]>();
  const diagnosticCaptures = new Map<
    GatewayProfileCommand["kind"],
    ReturnType<typeof startGatewayBenchDiagnostics>
  >();
  const workerMessageStarts = new Map<
    GatewayProfileCommand["kind"],
    ReturnType<typeof getWorkerMessageMetrics>
  >();
  const deserializeCaptures = new Map<
    GatewayProfileCommand["kind"],
    Map<string, { count: number; bytes: number }>
  >();
  const nativeDeserialize = v8.deserialize;
  const measuredDeserialize: typeof v8.deserialize = (buffer) => {
    const value: unknown = nativeDeserialize(buffer);
    const kind =
      value !== null &&
      typeof value === "object" &&
      "kind" in value &&
      typeof value.kind === "string"
        ? value.kind
        : "untyped";
    for (const groups of deserializeCaptures.values()) {
      let metric = groups.get(kind);
      if (!metric) {
        metric = { count: 0, bytes: 0 };
        groups.set(kind, metric);
      }
      metric.count++;
      metric.bytes += buffer.byteLength;
    }
    return value;
  };
  const namedDiagnostics = new Map<
    string | undefined,
    ReturnType<typeof startGatewayBenchDiagnostics>
  >();
  let busy = false;
  process.on("message", (message: GatewayBenchCommand) => {
    if (message?.channel !== GATEWAY_PROFILE_CHANNEL) {
      return;
    }
    if (message.kind === "resource-usage" && message.action === "sample") {
      void (async () => {
        if (message.initial && message.includeWorkers) {
          throw new Error("Worker memory requires a current resource sample");
        }
        let sessionCensus: GatewayResourceSnapshot["sessionCensus"];
        if (message.sessionCensus || message.clearPromptCacheObservations) {
          if (!message.collectGarbage || message.initial) {
            throw new Error("Session attribution requires a current forced-GC resource sample");
          }
          const sourceEntry = fileURLToPath(new URL("../../src/entry.ts", import.meta.url));
          if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(sourceEntry)) {
            throw new Error(
              "Session attribution requires --entry src/entry.ts; bundled modules have a different identity",
            );
          }
        }
        if (message.clearPromptCacheObservations) {
          const { clearPromptCacheObservations } =
            await import("../../src/agents/embedded-agent-runner/prompt-cache-observability.js");
          clearPromptCacheObservations();
        }
        if (message.collectGarbage) {
          if (!inspectorConnected) {
            inspector.connect();
            inspectorConnected = true;
          }
          await inspector.post("HeapProfiler.collectGarbage");
        }
        if (message.sessionCensus) {
          // Match the source runtime's module identities; count-only queries never retain instances.
          const [{ SessionManager }, { AgentSession }, { Agent }] = await Promise.all([
            import("../../src/agents/sessions/session-manager.js"),
            import("../../src/agents/sessions/agent-session.js"),
            import("../../src/agents/runtime/index.js"),
          ]);
          sessionCensus = {
            scope: "source-main-isolate",
            SessionManager: queryObjects(SessionManager, { format: "count" }),
            AgentSession: queryObjects(AgentSession, { format: "count" }),
            Agent: queryObjects(Agent, { format: "count" }),
          };
        }
        // Native benchmark children do not load the Gateway's source registry or loader.
        if (message.includeWorkers) {
          workerMemoryModule ??= await import("../../src/infra/worker-cpu.ts");
        }
        const workerMemory = message.includeWorkers
          ? workerMemoryModule?.sampleTrackedWorkerMemory()
          : undefined;
        const resources = message.initial
          ? initialResources
          : {
              ...sampleResources(),
              ...(workerMemory ? { workers: workerMemory } : {}),
              ...(sessionCensus ? { sessionCensus } : {}),
            };
        if (message.snapshotPath) {
          writeHeapSnapshot(message.snapshotPath);
        }
        return resources;
      })().then(
        (resources) =>
          process.send?.({
            channel: GATEWAY_PROFILE_CHANNEL,
            kind: message.kind,
            action: message.action,
            resources,
          }),
        (error: unknown) =>
          process.send?.({
            channel: GATEWAY_PROFILE_CHANNEL,
            kind: message.kind,
            action: message.action,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return;
    }
    if (message.kind === "cpu-usage" && message.action === "sample") {
      process.send?.({
        channel: GATEWAY_PROFILE_CHANNEL,
        kind: message.kind,
        action: message.action,
        cpuUsage: sampleCpu(),
      });
      return;
    }
    const reply = (error?: string) => {
      process.send?.({
        channel: GATEWAY_PROFILE_CHANNEL,
        kind: message.kind,
        action: message.action,
        error,
        ...(message.kind === "diagnostics" ? { captureId: message.captureId } : {}),
      });
    };
    if (broadcastTiming && !broadcastTimingInstalled && message.action === "start") {
      reply("Broadcast timing owner was not loaded; source attribution is unavailable");
      return;
    }
    if (message.kind === "diagnostics") {
      const captureId = message.captureId;
      if (message.action === "start") {
        if (namedDiagnostics.has(captureId)) {
          reply("Gateway diagnostics already started");
          return;
        }
        namedDiagnostics.set(captureId, startGatewayBenchDiagnostics());
        markGc("diagnostics-start", captureId);
        reply();
      } else {
        const stopDiagnostics = namedDiagnostics.get(captureId);
        if (!stopDiagnostics) {
          reply("Gateway diagnostics have not started");
          return;
        }
        markGc("diagnostics-stop", captureId);
        const result = stopDiagnostics();
        namedDiagnostics.delete(captureId);
        process.send?.({
          channel: GATEWAY_PROFILE_CHANNEL,
          kind: message.kind,
          action: message.action,
          diagnostics: result,
          captureId: message.captureId,
        });
      }
      return;
    }
    if (busy) {
      reply("Gateway profile command already in progress");
      return;
    }
    busy = true;
    void (async () => {
      if (message.kind !== "cpu" && message.kind !== "heap") {
        throw new Error("Unknown Gateway profile kind");
      }
      if (!inspectorConnected) {
        inspector.connect();
        inspectorConnected = true;
      }
      if (message.action === "start") {
        if (active.has(message.kind)) {
          throw new Error(`Gateway ${message.kind} profile already started`);
        }
        if (message.includeWorkers) {
          workerMemoryModule ??= await import("../../src/infra/worker-cpu.ts");
        }
        if (message.kind === "cpu") {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.setSamplingInterval", {
            interval: GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
          });
          await inspector.post("Profiler.start");
        } else {
          // Churn includes dead allocations; retention captures only survivors.
          const options = {
            samplingInterval: message.samplingIntervalBytes ?? GATEWAY_HEAP_SAMPLE_INTERVAL,
            includeObjectsCollectedByMajorGC: message.includeCollectedObjects ?? true,
            includeObjectsCollectedByMinorGC: message.includeCollectedObjects ?? true,
          };
          await inspector.post("HeapProfiler.startSampling", options);
        }
        active.add(message.kind);
        if (message.includeWorkers) {
          await workers.start(message.kind, message.profilePath, message);
        }
        diagnosticCaptures.set(message.kind, startGatewayBenchDiagnostics());
        workerMessageStarts.set(message.kind, getWorkerMessageMetrics());
        deserializeCaptures.set(message.kind, new Map());
        v8.deserialize = measuredDeserialize;
        syncBuiltinESMExports();
        if (message.kind === "heap") {
          markGc("heap-start", message.profilePath);
        }
      } else if (message.action === "stop") {
        if (!active.has(message.kind)) {
          throw new Error(`Gateway ${message.kind} profile has not started`);
        }
        const deserialized = Object.fromEntries(deserializeCaptures.get(message.kind) ?? []);
        deserializeCaptures.delete(message.kind);
        if (deserializeCaptures.size === 0) {
          v8.deserialize = nativeDeserialize;
          syncBuiltinESMExports();
        }
        if (message.kind === "heap") {
          // Exclude diagnostics aggregation and profile materialization from promotion.
          markGc("heap-stop", message.profilePath);
        }
        const diagnostics = diagnosticCaptures.get(message.kind)?.();
        diagnosticCaptures.delete(message.kind);
        const beforeMessages = workerMessageStarts.get(message.kind) ?? [];
        workerMessageStarts.delete(message.kind);
        const workerMessages = getWorkerMessageMetrics()
          .map((counter) => {
            const before = beforeMessages.find(
              (entry) => entry.kind === counter.kind && entry.direction === counter.direction,
            );
            return {
              kind: counter.kind,
              direction: counter.direction,
              messages: counter.messages - (before?.messages ?? 0),
              payloadBytes: counter.payloadBytes - (before?.payloadBytes ?? 0),
              unmeasuredMessages: counter.unmeasuredMessages - (before?.unmeasuredMessages ?? 0),
            };
          })
          .filter((counter) => counter.messages > 0);
        try {
          // Stop worker sampling before materializing the main profile and its sidecars.
          const [{ profile }] = await Promise.all([
            message.kind === "cpu"
              ? inspector.post("Profiler.stop")
              : inspector.post("HeapProfiler.stopSampling"),
            workers.stop(message.kind),
          ]);
          active.delete(message.kind);
          writeFileSync(message.profilePath, JSON.stringify(profile), { mode: 0o600 });
          writeFileSync(
            `${message.profilePath}.worker-messages.json`,
            JSON.stringify(workerMessages),
            { mode: 0o600 },
          );
          writeFileSync(
            `${message.profilePath}.deserialize.json`,
            JSON.stringify({ scope: "main-isolate", groups: deserialized }),
            { mode: 0o600 },
          );
          if (diagnostics) {
            writeFileSync(`${message.profilePath}.diagnostics.json`, JSON.stringify(diagnostics), {
              mode: 0o600,
            });
          }
        } finally {
          await workers.stop(message.kind);
        }
      } else {
        throw new Error("Unknown Gateway profile command");
      }
    })().then(
      () => {
        busy = false;
        reply();
      },
      (error: unknown) => {
        busy = false;
        reply(error instanceof Error ? error.message : String(error));
      },
    );
  });
  process.once("disconnect", () => {
    v8.deserialize = nativeDeserialize;
    syncBuiltinESMExports();
    deserializeCaptures.clear();
    for (const finish of namedDiagnostics.values()) {
      finish();
    }
    namedDiagnostics.clear();
    for (const finish of diagnosticCaptures.values()) {
      finish();
    }
    diagnosticCaptures.clear();
    if (inspectorConnected) {
      inspector.disconnect();
    }
  });
  process.channel?.unref();
}
