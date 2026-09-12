import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_PROFILE_CHANNEL = "openclaw-gateway-bench-profile";
export const GATEWAY_HEAP_SAMPLE_INTERVAL = 32 * 1024;
export const GATEWAY_CPU_SAMPLE_INTERVAL_MICROS = 1_000;

export type GatewayProfileCommand = {
  channel: typeof GATEWAY_PROFILE_CHANNEL;
  kind: "heap" | "cpu";
  action: "start" | "stop";
  profilePath: string;
};

type GatewayProfileReply = {
  channel: typeof GATEWAY_PROFILE_CHANNEL;
  kind: GatewayProfileCommand["kind"];
  action: "start" | "stop";
  error?: string;
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
};

export type GatewayCpuProfile = {
  profilePath: string;
  samplingIntervalMicros: number;
  durationMs: number;
  sampleCount: number;
};

export async function controlGatewayProfile(
  child: ChildProcess,
  kind: GatewayProfileCommand["kind"],
  action: GatewayProfileCommand["action"],
  profilePath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("disconnect", onDisconnect);
      if (error) {
        reject(error);
      } else {
        resolve();
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
      finish(message.error ? new Error(message.error) : undefined);
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
    if (!child.connected) {
      onDisconnect();
      return;
    }
    child.send({ channel: GATEWAY_PROFILE_CHANNEL, kind, action, profilePath }, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

export function readGatewayCpuProfile(profilePath: string): GatewayCpuProfile {
  const profile: Profiler.Profile = JSON.parse(readFileSync(profilePath, "utf8"));
  return {
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
    profilePath,
    samplingIntervalBytes: GATEWAY_HEAP_SAMPLE_INTERVAL,
    includesCollectedObjects: true,
    sampledAllocatedBytes,
    topAllocationSites: sites.toSorted((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 20),
  };
}
