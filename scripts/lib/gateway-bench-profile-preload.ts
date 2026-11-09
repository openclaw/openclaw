import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8, { getHeapSpaceStatistics, queryObjects, writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";
import { getSessionRowSelectionMetrics } from "../../src/infra/gateway-work-metrics.ts";
import { startGatewayBenchDiagnostics } from "./gateway-bench-diagnostics.ts";
import {
  GATEWAY_PROFILE_CHANNEL,
  writeGatewayGcTraceMarker,
  GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  type GatewayBenchCommand,
  type GatewayProfileCommand,
  type GatewayCpuUsageSnapshot,
  type GatewayResourceSnapshot,
} from "./gateway-bench-profile.ts";
import {
  gatewayBenchMessageLabel,
  instrumentGatewayBenchWorkerSource,
  startGatewayBenchWorkerMessages,
} from "./gateway-bench-worker-messages.ts";
import { GatewayBenchWorkerProfiler } from "./gateway-bench-worker-profile.ts";

// Count-only observer. Real producer/queue/preparation owners still execute unchanged.
const transcriptObservation = new AsyncLocalStorage<string>();
const transcriptChannel = channel("openclaw.benchmark.session-projection");
const transcriptRows = new Map<string, Record<string, string>>();
const transcriptKind = (update: {
  message?: unknown;
  messageId?: string;
  target?: { sessionKey?: string };
  sessionKey?: string;
}) => {
  const key = update.target?.sessionKey ?? update.sessionKey;
  if (!key?.startsWith("agent:main:transcript-broadcast-measure-child-")) {
    return undefined;
  }
  const message = update.message as { role?: string; content?: { type?: string }[] } | undefined;
  const role =
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "toolCall")
      ? "tool-call"
      : (message?.role ?? "marker");
  return `${update.messageId?.startsWith("transcript-bench-") ? "probe" : "other"}-${role}`;
};
export const benchmarkTranscriptPublication = {
  reset() {
    transcriptRows.clear();
  },
  count(operation: string, kind = transcriptObservation.getStore(), durationMs?: number) {
    const sourceKind =
      kind ??
      (operation === "materialization" || operation.startsWith("presentation-")
        ? "unattributed"
        : undefined);
    if (sourceKind) {
      transcriptChannel.publish({
        operation: `transcript.${operation}.${sourceKind}`,
        publications: 1,
        durationMs,
      });
    }
  },
  input(update: Parameters<typeof transcriptKind>[0]) {
    this.count("input", transcriptKind(update));
  },
  run<T>(update: Parameters<typeof transcriptKind>[0], consume: () => T): T {
    const kind = transcriptKind(update);
    if (!kind) {
      return consume();
    }
    return transcriptObservation.run(kind, () => {
      this.count("handled");
      return consume();
    });
  },
  consume<T>(consume: () => T): T {
    const started = performance.now();
    try {
      return consume();
    } finally {
      this.count("consume", undefined, performance.now() - started);
    }
  },
  row(row: Record<string, unknown> | undefined) {
    if (!row || !transcriptObservation.getStore() || !transcriptChannel.hasSubscribers) {
      return;
    }
    const key = JSON.stringify([row.agentId, row.key]);
    const next: Record<string, string> = {};
    for (const [field, value] of Object.entries(row)) {
      const encoded = JSON.stringify(value);
      if (encoded !== undefined) {
        next[field] = encoded;
      }
    }
    const previous = transcriptRows.get(key);
    transcriptRows.set(key, next);
    if (!previous) {
      this.count("row-first");
      return;
    }
    let changed = false;
    for (const field of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[field] === next[field]) {
        continue;
      }
      this.count(`field-${field}`);
      if (field !== "snapshotAt") {
        changed = true;
      }
    }
    this.count(changed ? "row-changed" : "row-unchanged");
  },
};

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
    sessionRowSelections: getSessionRowSelectionMetrics(),
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
  if (process.env.OPENCLAW_BENCH_DISABLE_INLINING === "1") {
    v8.setFlagsFromString("--no-turbo-inlining --no-maglev-inlining");
  }
  const broadcastTiming = process.env.OPENCLAW_BENCH_BROADCAST_TIMING === "1";
  const workerAttribution = process.env.OPENCLAW_BENCH_WORKER_ATTRIBUTION === "1";
  const workerAttributionSourceHooks = new Set<string>();
  const sessionProjectionCounts = process.env.OPENCLAW_BENCH_SESSION_PROJECTION_COUNTS === "1";
  const transcriptPublicationCounts =
    process.env.OPENCLAW_BENCH_TRANSCRIPT_PUBLICATION_COUNTS === "1";
  const sessionProjectionSource = process.env.OPENCLAW_BENCH_SESSION_PROJECTION_SOURCE;
  const historySource = process.env.OPENCLAW_BENCH_HISTORY_SOURCE;
  const retainToolContext = process.env.OPENCLAW_BENCH_RETAIN_TOOL_CONTEXT === "1";
  const toolExecutionSource = process.env.OPENCLAW_BENCH_TOOL_EXECUTION_SOURCE;
  let broadcastTimingInstalled = false;
  let sessionProjectionCountsInstalled = false;
  if (
    broadcastTiming ||
    sessionProjectionCounts ||
    transcriptPublicationCounts ||
    sessionProjectionSource ||
    workerAttribution ||
    historySource ||
    retainToolContext ||
    toolExecutionSource
  ) {
    const entry = new URL("../../src/entry.ts", import.meta.url);
    if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(entry)) {
      throw new Error("Benchmark source instrumentation requires --entry src/entry.ts");
    }
    const projectionSources = new Map<string, string>();
    if (sessionProjectionSource) {
      for (const file of [
        "server-broadcast.ts",
        "session-event-projection.ts",
        "session-row-presentation.ts",
        "session-sharing-read.ts",
        "session-utils-list.ts",
        "session-row-placement-projection.ts",
        "session-ancestor-references.ts",
        "server-connection-state.ts",
        "server-methods/sessions-read.ts",
        "server-methods/sessions-read-by-key.ts",
      ]) {
        projectionSources.set(
          new URL(`../../src/gateway/${file}`, import.meta.url).href,
          readFileSync(path.join(sessionProjectionSource, file), "utf8"),
        );
      }
    }
    if (historySource) {
      for (const file of ["chat-history-session-read.ts", "chat-history-handler.ts"]) {
        projectionSources.set(
          new URL(`../../src/gateway/server-methods/${file}`, import.meta.url).href,
          readFileSync(path.join(historySource, file), "utf8"),
        );
      }
    }
    const owner = new URL("../../src/gateway/server-broadcast.ts", import.meta.url).href;
    const workerOwners = new Map(
      ["worker-message-metrics.ts", "sqlite-worker-operation-admission.ts", "worker-cpu.ts"].map(
        (file) => [new URL(`../../src/infra/${file}`, import.meta.url).href, file],
      ),
    );
    workerOwners.set(
      new URL("../../packages/worker-runtime/src/worker-task-pool-core.ts", import.meta.url).href,
      "worker-task-pool-core.ts",
    );
    const transformWorkerSource = workerAttribution
      ? (await import("esbuild")).transformSync
      : undefined;
    const projectionOwner = new URL(
      "../../src/gateway/session-event-projection.ts",
      import.meta.url,
    ).href;
    const toolContextOwner = new URL(
      "../../packages/agent-core/src/tool-execution-context.ts",
      import.meta.url,
    ).href;
    const toolExecutionOwner = new URL(
      "../../packages/agent-core/src/agent-loop-tool-execution.ts",
      import.meta.url,
    ).href;

    registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (transcriptPublicationCounts) {
          const replacements: readonly (readonly [string, string])[] =
            url === new URL("../../src/gateway/server-session-events.ts", import.meta.url).href
              ? [
                  [
                    "  return (update: InternalSessionTranscriptUpdate): Promise<false | void> => {",
                    "  return (update: InternalSessionTranscriptUpdate): Promise<false | void> => {\n    benchmarkTranscriptPublication.input(update);",
                  ],
                  [
                    "const published = await handleTranscriptUpdateBroadcast(",
                    "const published = await benchmarkTranscriptPublication.run(pending.update, () => handleTranscriptUpdateBroadcast(",
                  ],
                  [
                    "sessionKey ? undefined : joinQueue,\n        );",
                    "sessionKey ? undefined : joinQueue,\n        ));",
                  ],
                  [
                    "      const sessionRow = record && read?.present(record);",
                    "      const sessionRow = record && read?.present(record);\n      benchmarkTranscriptPublication.row(sessionRow);",
                  ],
                ]
              : url ===
                  new URL("../../src/gateway/session-event-prepared-row.ts", import.meta.url).href
                ? [
                    [
                      "                yieldUntil = claimTurn(resumed);",
                      "                benchmarkTranscriptPublication.count('consume-attempt');\n                yieldUntil = claimTurn(resumed);",
                    ],
                    [
                      "                return yieldUntil ? deferred : consume(read);",
                      "                if (yieldUntil) benchmarkTranscriptPublication.count('deferred');\n                return yieldUntil ? deferred : benchmarkTranscriptPublication.consume(() => consume(read));",
                    ],
                  ]
                : url ===
                    new URL("../../src/gateway/session-row-projection.ts", import.meta.url).href
                  ? [
                      [
                        "materializedSequence: ++materializedCount,",
                        "materializedSequence: (benchmarkTranscriptPublication.count('materialization'), ++materializedCount),",
                      ],
                    ]
                  : url ===
                      new URL("../../src/gateway/session-row-projection-record.ts", import.meta.url)
                        .href
                    ? [
                        [
                          "  const now = options.now ?? Date.now();",
                          "  benchmarkTranscriptPublication.count(record.key.startsWith('agent:main:transcript-broadcast-measure-child-') ? 'presentation-leaf' : 'presentation-ancestor');\n  const now = options.now ?? Date.now();",
                        ],
                      ]
                    : [];
          if (replacements.length) {
            let source = readFileSync(new URL(url), "utf8");
            for (const [anchor, replacement] of replacements) {
              if (source.split(anchor).length !== 2) {
                throw new Error(`Transcript count anchor changed in ${url}`);
              }
              source = source.replace(anchor, replacement);
            }
            return {
              ...loaded,
              format: "module-typescript",
              source: `import { benchmarkTranscriptPublication } from ${JSON.stringify(import.meta.url)};\n${source}`,
            };
          }
        }
        if (toolExecutionSource && url === toolExecutionOwner) {
          return {
            ...loaded,
            format: "module-typescript",
            source: readFileSync(toolExecutionSource, "utf8"),
          };
        }
        if (retainToolContext && url === toolContextOwner) {
          const source = readFileSync(new URL(url), "utf8");
          const anchor = "return activeToolExecution.run(context, run);";
          if (source.split(anchor).length !== 2) {
            throw new Error("Tool context retention anchor changed; update the benchmark observer");
          }
          // Model a long-lived socket/timer inheriting a tool's async context, without retaining
          // its producer, result, or session directly. Attribution remains available after settlement.
          return {
            ...loaded,
            format: "module-typescript",
            source: `const benchmarkToolContexts = new WeakSet<object>();
const benchmarkToolSnapshots: ReturnType<typeof AsyncLocalStorage.snapshot>[] = [];
${source.replace(
  anchor,
  `return activeToolExecution.run(context, () => {
    if (!benchmarkToolContexts.has(context)) {
      benchmarkToolContexts.add(context);
      benchmarkToolSnapshots.push(AsyncLocalStorage.snapshot());
      console.log("BENCH_RETAINED_TOOL_CONTEXTS " + benchmarkToolSnapshots.length);
    }
    return run();
  });`,
)}`,
          };
        }
        const workerOwner = workerAttribution && workerOwners.get(url);
        if (workerOwner) {
          const source = instrumentGatewayBenchWorkerSource(
            workerOwner,
            readFileSync(new URL(url), "utf8"),
          );
          workerAttributionSourceHooks.add(workerOwner);
          if (workerOwner === "worker-task-pool-core.ts" && transformWorkerSource) {
            // The package core uses parameter properties; Node's strip-only mode cannot load it.
            return {
              ...loaded,
              format: "module",
              source: transformWorkerSource(source, {
                loader: "ts",
                format: "esm",
                target: "node26",
                sourcemap: "inline",
                sourcefile: fileURLToPath(url),
              }).code,
            };
          }
          return {
            ...loaded,
            format: "module-typescript",
            source,
          };
        }
        const projectionSource = projectionSources.get(url);
        if (sessionProjectionCounts && url === projectionOwner) {
          let source = projectionSource ?? readFileSync(new URL(url), "utf8");
          // Source-overlay comparisons also load the pre-sharing baseline owner.
          const sharedDelivery = source.includes("      return projected;");
          const returnAnchor = sharedDelivery
            ? "      return projected;"
            : "      return {\n        payload: wirePayload,";
          const payload = sharedDelivery ? "projected.payload" : "wirePayload";
          const replacements = [
            [
              "    const audiences = new Map<",
              `    const benchmarkProjectionPayloads = new Set<object>();
    benchmarkSessionProjectionChannel.publish({ operation: event, publications: 1 });
    const audiences = new Map<`,
            ],
            [
              "      if (!audience) {",
              `      if (!audience) {
        benchmarkSessionProjectionChannel.publish({ operation: event, audienceCacheMisses: 1 });`,
            ],
            [
              "      if (!projected) {",
              `      if (!projected) {
        benchmarkSessionProjectionChannel.publish({ operation: event, payloadCacheMisses: 1 });`,
            ],
            [
              returnAnchor,
              `      benchmarkSessionProjectionChannel.publish({
        operation: event,
        projectedRecipients: 1,
        wirePayloads: benchmarkProjectionPayloads.has(${payload}) ? 0 : 1,
      });
      benchmarkProjectionPayloads.add(${payload});
${returnAnchor}`,
            ],
          ] as const;
          for (const [anchor, replacement] of replacements) {
            if (source.split(anchor).length !== 2) {
              throw new Error(
                "Session projection count anchors changed; update the benchmark observer",
              );
            }
            source = source.replace(anchor, replacement);
          }
          source = `import { channel as benchmarkProjectionDiagnosticChannel } from "node:diagnostics_channel";
const benchmarkSessionProjectionChannel = benchmarkProjectionDiagnosticChannel("openclaw.benchmark.session-projection");
${source}`;
          sessionProjectionCountsInstalled = true;
          return { ...loaded, format: "module-typescript", source };
        }
        if (projectionSource !== undefined && url !== owner) {
          // Preserve canonical imports and original TypeScript lines in sampled stacks.
          return { ...loaded, format: "module-typescript", source: projectionSource };
        }
        if (url !== owner) {
          return loaded;
        }
        let source = projectionSource ?? readFileSync(new URL(url), "utf8");
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
  // Import after installing source observers; an eager import bypasses the load hook.
  const { getWorkerMessageMetrics } = await import("../../src/infra/worker-message-metrics.ts");
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
  const traceGc =
    process.env.OPENCLAW_BENCH_TRACE_GC === "1" || process.execArgv.includes("--trace-gc-nvp");
  if (traceGc) {
    // Enable tracing here: Worker rejects this flag when inherited through execArgv.
    v8.setFlagsFromString("--trace-gc-nvp");
  }
  const markGc = (phase: string, profilePath?: string) => {
    if (traceGc) {
      writeGatewayGcTraceMarker(phase, profilePath);
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
  const workerAttributionCaptures = new Map<
    GatewayProfileCommand["kind"],
    ReturnType<typeof startGatewayBenchWorkerMessages>
  >();
  const nativeDeserialize = v8.deserialize;
  const measuredDeserialize: typeof v8.deserialize = (buffer) => {
    const value: unknown = nativeDeserialize(buffer);
    const kind =
      value !== null &&
      typeof value === "object" &&
      "kind" in value &&
      typeof value.kind === "string"
        ? gatewayBenchMessageLabel(value.kind)
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
          // Scope source aliases to instrumentation; built Gateway imports stay native.
          workerMemoryModule ??= await tsImport("../../src/infra/worker-cpu.ts", {
            parentURL: import.meta.url,
            tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
          });
        }
        const workerMemory = message.includeWorkers
          ? workerMemoryModule?.sampleTrackedWorkerMemory()
          : undefined;
        let databaseIntegrity: GatewayResourceSnapshot["databaseIntegrity"];
        if (message.databaseIntegrity) {
          const [
            { readSqliteDatabaseIntegrityVerification },
            { captureAgentDatabaseStartupIntegrity },
          ] = await Promise.all([
            import("../../src/infra/sqlite-database-admission.js"),
            import("../../src/state/agent-database-startup-integrity.js"),
          ]);
          const { pathname, agentId } = message.databaseIntegrity;
          databaseIntegrity = {
            ...readSqliteDatabaseIntegrityVerification(pathname),
            pending: Boolean(captureAgentDatabaseStartupIntegrity(pathname, agentId)),
          };
        }
        const resources = message.initial
          ? initialResources
          : {
              ...sampleResources(),
              ...(databaseIntegrity ? { databaseIntegrity } : {}),
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
      void (async () => {
        const workerCpu = message.includeWorkers ? await workers.sampleCpu() : undefined;
        return { ...sampleCpu(), ...(workerCpu ? { workerCpu } : {}) };
      })().then(
        (cpuUsage) =>
          process.send?.({
            channel: GATEWAY_PROFILE_CHANNEL,
            kind: message.kind,
            action: message.action,
            cpuUsage,
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
    if (
      sessionProjectionCounts &&
      !sessionProjectionCountsInstalled &&
      message.action === "start"
    ) {
      reply("Session projection owner was not loaded; count attribution is unavailable");
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
        if (transcriptPublicationCounts) {
          benchmarkTranscriptPublication.reset();
        }
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
          workerMemoryModule ??= await tsImport("../../src/infra/worker-cpu.ts", {
            parentURL: import.meta.url,
            tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
          });
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
        if (workerAttribution) {
          workerAttributionCaptures.set(message.kind, startGatewayBenchWorkerMessages());
        }
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
        const workerAttributionResult = workerAttributionCaptures.get(message.kind)?.();
        workerAttributionCaptures.delete(message.kind);
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
          if (workerAttributionResult) {
            writeFileSync(
              `${message.profilePath}.worker-attribution.json`,
              JSON.stringify({
                ...workerAttributionResult,
                sourceHooks: [...workerAttributionSourceHooks].toSorted(),
              }),
              { mode: 0o600 },
            );
          }
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
    for (const finish of workerAttributionCaptures.values()) {
      finish();
    }
    workerAttributionCaptures.clear();
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
