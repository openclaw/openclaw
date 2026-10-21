import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HeapSpaceInfo } from "node:v8";
import type { sampleTrackedWorkerMemory } from "../../src/infra/worker-cpu.ts";
import type { WorkerMessageMetric } from "../../src/infra/worker-message-metrics.ts";
import type { startGatewayBenchDiagnostics } from "./gateway-bench-diagnostics.ts";

export const GATEWAY_PROFILE_CHANNEL = "openclaw-gateway-bench-profile";
export const GATEWAY_GC_TRACE_MARKER = "OPENCLAW_GATEWAY_BENCH_GC ";
export const GATEWAY_HEAP_SAMPLE_INTERVAL = 32 * 1024;
export const GATEWAY_CPU_SAMPLE_INTERVAL_MICROS = 1_000;

export type GatewayProfileCommand = {
  channel: typeof GATEWAY_PROFILE_CHANNEL;
  kind: "heap" | "cpu";
  action: "start" | "stop";
  profilePath: string;
  includeWorkers?: boolean;
  includeCollectedObjects?: boolean;
  samplingIntervalBytes?: number;
};

export type GatewayCpuUsageSnapshot = {
  pid: number;
  cpuEnvironment?: { availableParallelism: number; affinity?: string };
  atMonotonicMicros: number;
  process: NodeJS.CpuUsage;
  mainThread: NodeJS.CpuUsage;
};

export type GatewayResourceSnapshot = GatewayCpuUsageSnapshot & {
  memory: NodeJS.MemoryUsage;
  heapSpaces: HeapSpaceInfo[];
  workers?: ReturnType<typeof sampleTrackedWorkerMemory>;
  activeResources: Record<string, number>;
  runtime: { node: string; platform: string; arch: string };
  sessionCensus?: {
    scope: "source-main-isolate";
    SessionManager: number;
    AgentSession: number;
    Agent: number;
  };
};

export type GatewayBenchCommand =
  | GatewayProfileCommand
  | {
      channel: typeof GATEWAY_PROFILE_CHANNEL;
      kind: "diagnostics";
      action: "start" | "stop";
      captureId?: string;
    }
  | { channel: typeof GATEWAY_PROFILE_CHANNEL; kind: "cpu-usage"; action: "sample" }
  | {
      channel: typeof GATEWAY_PROFILE_CHANNEL;
      kind: "resource-usage";
      action: "sample";
      initial?: boolean;
      includeWorkers?: boolean;
      collectGarbage?: boolean;
      sessionCensus?: boolean;
      clearPromptCacheObservations?: boolean;
      snapshotPath?: string;
    };

type GatewayProfileReply = {
  channel: typeof GATEWAY_PROFILE_CHANNEL;
  kind: GatewayBenchCommand["kind"];
  action: GatewayBenchCommand["action"];
  error?: string;
  cpuUsage?: GatewayCpuUsageSnapshot;
  resources?: GatewayResourceSnapshot;
  diagnostics?: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>>;
  captureId?: string;
};

export type GatewayCpuUsage = Omit<ReturnType<typeof measureGatewayCpuUsage>, "cpuEnvironment"> &
  Pick<GatewayCpuUsageSnapshot, "cpuEnvironment">;
export type GatewayHeapProfile = ReturnType<typeof readGatewayHeapProfile>;
export type GatewayCpuProfile = ReturnType<typeof readGatewayCpuProfile>;

type GatewayProfileArtifacts = {
  diagnosticsPath?: string;
  diagnostics?: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>>;
  workerMessages?: WorkerMessageMetric[];
};

function readProfileArtifacts(profilePath: string): GatewayProfileArtifacts {
  const diagnosticsPath = `${profilePath}.diagnostics.json`;
  const workerMessagesPath = `${profilePath}.worker-messages.json`;
  return {
    ...(existsSync(diagnosticsPath)
      ? { diagnosticsPath, diagnostics: JSON.parse(readFileSync(diagnosticsPath, "utf8")) }
      : {}),
    ...(existsSync(workerMessagesPath)
      ? { workerMessages: JSON.parse(readFileSync(workerMessagesPath, "utf8")) }
      : {}),
  };
}

/** Read promoted bytes from V8, excluding worker isolates and GC outside this capture. */
export function readGatewayGcTrace(
  logPath: string,
  profilePath: string,
  captureKind: "heap" | "diagnostics" = "heap",
) {
  let identifying = false;
  let identified = false;
  let pid: number | undefined;
  const isolates = new Set<string>();
  let capturing = false;
  let completed = false;
  let promotedBytes = 0;
  let gcCount = 0;
  let excludedWorkerGcCount = 0;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.startsWith(GATEWAY_GC_TRACE_MARKER)) {
      const marker: { phase: string; pid: number; profilePath?: string } = JSON.parse(
        line.slice(GATEWAY_GC_TRACE_MARKER.length),
      );
      if (marker.phase === "identify-start") {
        if (identifying || identified) {
          throw new Error("GC trace contains multiple Gateway identification windows");
        }
        pid = marker.pid;
        identifying = true;
      } else if (marker.phase === "identify-stop") {
        if (!identifying || marker.pid !== pid || isolates.size !== 1) {
          throw new Error("GC trace did not identify exactly one main isolate");
        }
        identifying = false;
        identified = true;
      } else if (marker.profilePath === profilePath) {
        if (marker.phase === `${captureKind}-start`) {
          if (!identified || marker.pid !== pid || capturing || completed) {
            throw new Error(`GC trace has an invalid ${captureKind} capture start`);
          }
          capturing = true;
        } else if (marker.phase === `${captureKind}-stop`) {
          if (!capturing || marker.pid !== pid) {
            throw new Error(`GC trace has an invalid ${captureKind} capture stop`);
          }
          capturing = false;
          completed = true;
        }
      }
      continue;
    }
    const trace = /^\[(\d+):(0x[\da-f]+)(?::\d+)?\]\s+\d+\s+ms:\s+(.*)$/i.exec(line);
    if (!trace || Number(trace[1]) !== pid) {
      continue;
    }
    const isolate = trace[2];
    const fields = trace[3];
    if (!isolate || !fields) {
      continue;
    }
    if (!identifying && !capturing) {
      continue;
    }
    if (capturing && !isolates.has(isolate)) {
      excludedWorkerGcCount += 1;
      continue;
    }
    // Recent V8 versions retain the flag but emit JSON instead of name=value pairs.
    const collection: { gc?: string; promoted?: number } = fields.startsWith("GC: ")
      ? JSON.parse(fields.slice(4))
      : {
          gc: /(?:^|\s)gc=(\S+)/.exec(fields)?.[1],
          promoted: Number(/(?:^|\s)promoted=(\S+)/.exec(fields)?.[1]),
        };
    if (!collection.gc) {
      continue;
    }
    if (identifying) {
      isolates.add(isolate);
    } else if (capturing) {
      const bytes = collection.promoted;
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("Main-isolate GC trace is missing a valid promoted byte count");
      }
      promotedBytes += bytes;
      gcCount += 1;
    }
  }
  if (!identified || !completed || capturing) {
    throw new Error(
      `GC trace is missing identification or the complete ${captureKind} capture window`,
    );
  }
  return {
    scope: "main-isolate" as const,
    source: "v8-trace-gc-nvp" as const,
    logPath,
    profilePath,
    pid,
    isolate: [...isolates][0],
    promotedBytes,
    gcCount,
    excludedWorkerGcCount,
  };
}

export async function controlGatewayProfile(
  child: ChildProcess,
  kind: GatewayProfileCommand["kind"],
  action: GatewayProfileCommand["action"],
  profilePath: string,
  options: {
    includeWorkers?: boolean;
    includeCollectedObjects?: boolean;
    samplingIntervalBytes?: number;
  } = {},
): Promise<void> {
  await sendGatewayBenchCommand(child, {
    channel: GATEWAY_PROFILE_CHANNEL,
    kind,
    action,
    profilePath,
    ...options,
  });
}

/** Lightweight main-isolate diagnostics, without CPU or allocation sampling. */
export async function startGatewayDiagnostics(child: ChildProcess, captureId?: string) {
  await sendGatewayBenchCommand(child, {
    channel: GATEWAY_PROFILE_CHANNEL,
    kind: "diagnostics",
    action: "start",
    captureId,
  });
  return async () => {
    const reply = await sendGatewayBenchCommand(child, {
      channel: GATEWAY_PROFILE_CHANNEL,
      kind: "diagnostics",
      action: "stop",
      captureId,
    });
    if (!reply.diagnostics) {
      throw new Error("Gateway did not report diagnostics");
    }
    return reply.diagnostics;
  };
}

export async function readGatewayCpuUsage(child: ChildProcess): Promise<GatewayCpuUsageSnapshot> {
  const reply = await sendGatewayBenchCommand(child, {
    channel: GATEWAY_PROFILE_CHANNEL,
    kind: "cpu-usage",
    action: "sample",
  });
  if (!reply.cpuUsage) {
    throw new Error("Gateway did not report CPU usage");
  }
  return reply.cpuUsage;
}

/** Samples the Gateway itself, not the controller or its descendants. */
export async function readGatewayResources(
  child: ChildProcess,
  options: {
    initial?: boolean;
    includeWorkers?: boolean;
    collectGarbage?: boolean;
    sessionCensus?: boolean;
    clearPromptCacheObservations?: boolean;
    snapshotPath?: string;
  } = {},
): Promise<GatewayResourceSnapshot> {
  const reply = await sendGatewayBenchCommand(child, {
    channel: GATEWAY_PROFILE_CHANNEL,
    kind: "resource-usage",
    action: "sample",
    ...options,
  });
  if (!reply.resources || reply.resources.pid !== child.pid) {
    throw new Error("Gateway did not report resources for the owned child PID");
  }
  return reply.resources;
}

export function measureGatewayCpuUsage(
  before: GatewayCpuUsageSnapshot,
  after: GatewayCpuUsageSnapshot,
) {
  if (before.pid !== after.pid || after.atMonotonicMicros <= before.atMonotonicMicros) {
    throw new Error("Gateway CPU samples must span one process and a positive interval");
  }
  if (
    before.cpuEnvironment?.availableParallelism !== after.cpuEnvironment?.availableParallelism ||
    before.cpuEnvironment?.affinity !== after.cpuEnvironment?.affinity
  ) {
    throw new Error("Gateway CPU affinity or available parallelism changed during measurement");
  }
  const delta = (start: NodeJS.CpuUsage, end: NodeJS.CpuUsage) => {
    const userMs = (end.user - start.user) / 1_000;
    const systemMs = (end.system - start.system) / 1_000;
    if (userMs < 0 || systemMs < 0) {
      throw new Error("Gateway CPU counters decreased during the measured interval");
    }
    return { userMs, systemMs, totalMs: userMs + systemMs };
  };
  return {
    pid: after.pid,
    cpuEnvironment: before.cpuEnvironment,
    startMonotonicMicros: before.atMonotonicMicros,
    endMonotonicMicros: after.atMonotonicMicros,
    wallMs: (after.atMonotonicMicros - before.atMonotonicMicros) / 1_000,
    process: delta(before.process, after.process),
    mainThread: delta(before.mainThread, after.mainThread),
  };
}

async function sendGatewayBenchCommand(
  child: ChildProcess,
  command: GatewayBenchCommand,
): Promise<GatewayProfileReply> {
  const { kind, action } = command;
  // Constructor census scans the full heap three times, unlike a resource sample.
  const timeoutMs = command.kind === "resource-usage" && command.sessionCensus ? 120_000 : 30_000;
  return await new Promise<GatewayProfileReply>((resolve, reject) => {
    const finish = (result: Error | GatewayProfileReply) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("disconnect", onDisconnect);
      child.off("error", finish);
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const onMessage = (message: GatewayProfileReply) => {
      if (
        message?.channel !== GATEWAY_PROFILE_CHANNEL ||
        message.kind !== kind ||
        message.action !== action ||
        (command.kind === "diagnostics" && message.captureId !== command.captureId)
      ) {
        return;
      }
      finish(message.error ? new Error(message.error) : message);
    };
    const onExit = () => finish(new Error(`Gateway exited during ${kind} profile ${action}`));
    const onDisconnect = () =>
      finish(new Error(`Gateway disconnected during ${kind} profile ${action}`));
    const timer = setTimeout(
      () => finish(new Error(`Gateway ${kind} profile ${action} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
    child.once("error", finish);
    if (!child.connected) {
      onDisconnect();
      return;
    }
    child.send(command, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

export function readGatewayCpuProfile(profilePath: string) {
  const profile: Profiler.Profile = JSON.parse(readFileSync(profilePath, "utf8"));
  return {
    ...readProfileArtifacts(profilePath),
    profilePath,
    samplingIntervalMicros: GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
    durationMs: (profile.endTime - profile.startTime) / 1_000,
    sampleCount: profile.samples?.length ?? 0,
  };
}

export function readGatewayHeapProfile(
  profilePath: string,
  options: { includeCollectedObjects?: boolean; samplingIntervalBytes?: number } = {},
) {
  const profile: HeapProfiler.SamplingHeapProfile = JSON.parse(readFileSync(profilePath, "utf8"));
  const sites: Array<{ sampledBytes: number; stack: string[] }> = [];
  let sampledAllocatedBytes = 0;
  const formatFrame = (frame: HeapProfiler.SamplingHeapProfileNode["callFrame"]): string => {
    const filePath = frame.url.startsWith("file://") ? fileURLToPath(frame.url) : frame.url;
    const url = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
    return `${frame.functionName || "(anonymous)"} (${url}:${frame.lineNumber + 1})`;
  };
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, parents: string[]) => {
    const stack = [...parents, formatFrame(node.callFrame)];
    sampledAllocatedBytes += node.selfSize;
    if (node.selfSize > 0) {
      sites.push({ sampledBytes: node.selfSize, stack: stack.slice(-8) });
    }
    for (const child of node.children) {
      visit(child, stack);
    }
  };
  visit(profile.head, []);
  return {
    ...readProfileArtifacts(profilePath),
    profilePath,
    samplingIntervalBytes: options.samplingIntervalBytes ?? GATEWAY_HEAP_SAMPLE_INTERVAL,
    includesCollectedObjects: options.includeCollectedObjects ?? true,
    sampledAllocatedBytes,
    topAllocationSites: sites.toSorted((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 20),
  };
}

/** Brackets completed operations; sampling and GC accounting run only in the owned child. */
export async function measureGatewayAllocations(
  child: ChildProcess,
  profilePath: string,
  operationCount: number,
  workload: () => Promise<void>,
) {
  if (!Number.isSafeInteger(operationCount) || operationCount < 1) {
    throw new Error("Allocation measurement needs a positive operation count");
  }
  const before = await readGatewayResources(child);
  await controlGatewayProfile(child, "heap", "start", profilePath);
  try {
    await workload();
  } finally {
    await controlGatewayProfile(child, "heap", "stop", profilePath);
  }
  const after = await readGatewayResources(child);
  const heap = readGatewayHeapProfile(profilePath);
  if (!heap.diagnostics || heap.diagnostics.collectionErrors > 0) {
    throw new Error("Allocation measurement has incomplete diagnostic accounting");
  }
  const gcMs = heap.diagnostics.gc.durationMs?.total ?? 0;
  return {
    scope: "main-isolate",
    runtime: after.runtime,
    operationCount,
    ...heap,
    estimatedAllocatedBytesPerOperation: heap.sampledAllocatedBytes / operationCount,
    gcMs,
    gcMsPerOperation: gcMs / operationCount,
    gcCount: heap.diagnostics.gc.durationMs?.count ?? 0,
    // Live heap and RSS deltas are context, never an allocation estimate.
    heapUsedDeltaBytes: after.memory.heapUsed - before.memory.heapUsed,
    rssDeltaBytes: after.memory.rss - before.memory.rss,
    cpu: measureGatewayCpuUsage(before, after),
  };
}
