import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { startGatewayBenchDiagnostics } from "./gateway-bench-diagnostics.ts";

export const GATEWAY_PROFILE_CHANNEL = "openclaw-gateway-bench-profile";
export const GATEWAY_HEAP_SAMPLE_INTERVAL = 32 * 1024;
export const GATEWAY_CPU_SAMPLE_INTERVAL_MICROS = 1_000;

export type GatewayProfileCommand = {
  channel: typeof GATEWAY_PROFILE_CHANNEL;
  kind: "heap" | "cpu";
  action: "start" | "stop";
  profilePath: string;
  includeWorkers?: boolean;
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
  activeResources: Record<string, number>;
  runtime: { node: string; platform: string; arch: string };
};

export type GatewayBenchCommand =
  | GatewayProfileCommand
  | { channel: typeof GATEWAY_PROFILE_CHANNEL; kind: "cpu-usage"; action: "sample" }
  | {
      channel: typeof GATEWAY_PROFILE_CHANNEL;
      kind: "resource-usage";
      action: "sample";
      initial?: boolean;
    };

type GatewayProfileReply = {
  channel: typeof GATEWAY_PROFILE_CHANNEL;
  kind: GatewayBenchCommand["kind"];
  action: GatewayBenchCommand["action"];
  error?: string;
  cpuUsage?: GatewayCpuUsageSnapshot;
  resources?: GatewayResourceSnapshot;
};

type CpuUsageMilliseconds = { userMs: number; systemMs: number; totalMs: number };

export type GatewayCpuUsage = {
  pid: number;
  cpuEnvironment?: { availableParallelism: number; affinity?: string };
  startMonotonicMicros: number;
  endMonotonicMicros: number;
  wallMs: number;
  process: CpuUsageMilliseconds;
  mainThread: CpuUsageMilliseconds;
};

export type GatewayHeapProfile = {
  profilePath: string;
  samplingIntervalBytes: number;
  includesCollectedObjects: true;
  sampledAllocatedBytes: number;
  topAllocationSites: Array<{
    sampledBytes: number;
    stack: string[];
  }>;
} & GatewayProfileArtifacts;

export type GatewayCpuProfile = {
  profilePath: string;
  samplingIntervalMicros: number;
  durationMs: number;
  sampleCount: number;
} & GatewayProfileArtifacts;

type GatewayProfileArtifacts = {
  diagnosticsPath?: string;
  diagnostics?: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>>;
};

function readProfileArtifacts(profilePath: string): GatewayProfileArtifacts {
  const diagnosticsPath = `${profilePath}.diagnostics.json`;
  return existsSync(diagnosticsPath)
    ? { diagnosticsPath, diagnostics: JSON.parse(readFileSync(diagnosticsPath, "utf8")) }
    : {};
}

export async function controlGatewayProfile(
  child: ChildProcess,
  kind: GatewayProfileCommand["kind"],
  action: GatewayProfileCommand["action"],
  profilePath: string,
  options: { includeWorkers?: boolean } = {},
): Promise<void> {
  await sendGatewayBenchCommand(child, {
    channel: GATEWAY_PROFILE_CHANNEL,
    kind,
    action,
    profilePath,
    ...options,
  });
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
  options: { initial?: boolean } = {},
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
): GatewayCpuUsage {
  if (before.pid !== after.pid || after.atMonotonicMicros <= before.atMonotonicMicros) {
    throw new Error("Gateway CPU samples must span one process and a positive interval");
  }
  if (
    before.cpuEnvironment?.availableParallelism !== after.cpuEnvironment?.availableParallelism ||
    before.cpuEnvironment?.affinity !== after.cpuEnvironment?.affinity
  ) {
    throw new Error("Gateway CPU affinity or available parallelism changed during measurement");
  }
  const delta = (start: NodeJS.CpuUsage, end: NodeJS.CpuUsage): CpuUsageMilliseconds => {
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
        message.action !== action
      ) {
        return;
      }
      finish(message.error ? new Error(message.error) : message);
    };
    const onExit = () => finish(new Error(`Gateway exited during ${kind} profile ${action}`));
    const onDisconnect = () =>
      finish(new Error(`Gateway disconnected during ${kind} profile ${action}`));
    const timer = setTimeout(
      () => finish(new Error(`Gateway ${kind} profile ${action} timed out after 30000ms`)),
      30_000,
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

export function readGatewayCpuProfile(profilePath: string): GatewayCpuProfile {
  const profile: Profiler.Profile = JSON.parse(readFileSync(profilePath, "utf8"));
  return {
    ...readProfileArtifacts(profilePath),
    profilePath,
    samplingIntervalMicros: GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
    durationMs: (profile.endTime - profile.startTime) / 1_000,
    sampleCount: profile.samples?.length ?? 0,
  };
}

export function readGatewayHeapProfile(profilePath: string): GatewayHeapProfile {
  const profile: HeapProfiler.SamplingHeapProfile = JSON.parse(readFileSync(profilePath, "utf8"));
  const sites: GatewayHeapProfile["topAllocationSites"] = [];
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
    samplingIntervalBytes: GATEWAY_HEAP_SAMPLE_INTERVAL,
    includesCollectedObjects: true,
    sampledAllocatedBytes,
    topAllocationSites: sites.toSorted((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 20),
  };
}
