import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_HEAP_PROFILE_CHANNEL = "openclaw-gateway-bench-heap";
export const GATEWAY_HEAP_SAMPLE_INTERVAL = 32 * 1024;

export type GatewayHeapProfileCommand = {
  channel: typeof GATEWAY_HEAP_PROFILE_CHANNEL;
  action: "start" | "stop";
  profilePath: string;
};

type GatewayHeapProfileReply = {
  channel: typeof GATEWAY_HEAP_PROFILE_CHANNEL;
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

export async function controlGatewayHeapProfile(
  child: ChildProcess,
  action: GatewayHeapProfileCommand["action"],
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
    const onMessage = (message: GatewayHeapProfileReply) => {
      if (message?.channel !== GATEWAY_HEAP_PROFILE_CHANNEL || message.action !== action) {
        return;
      }
      finish(message.error ? new Error(message.error) : undefined);
    };
    const onExit = () => finish(new Error(`Gateway exited during heap profile ${action}`));
    const onDisconnect = () =>
      finish(new Error(`Gateway disconnected during heap profile ${action}`));
    const timer = setTimeout(
      () => finish(new Error(`Gateway heap profile ${action} timed out after 30000ms`)),
      30_000,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
    if (!child.connected) {
      onDisconnect();
      return;
    }
    child.send({ channel: GATEWAY_HEAP_PROFILE_CHANNEL, action, profilePath }, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
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
