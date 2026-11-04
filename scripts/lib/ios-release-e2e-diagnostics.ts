import { execFile } from "node:child_process";
import { freemem, loadavg, platform, totalmem } from "node:os";
import { stripVTControlCharacters } from "node:util";

type GatewayLogEvent = {
  event: string;
  durationMs?: number;
  queueDepth?: number;
  waitMs?: number;
  overdueMs?: number;
  elapsedMs?: number;
  pending?: Record<string, boolean>;
};

export function summarizeIOSBuildTiming(output: string) {
  const tasks = new Set([
    "SwiftCompile",
    "SwiftEmitModule",
    "SwiftDriver",
    "SwiftDriver Compilation",
    "SwiftDriver Compilation Requirements",
    "CompileC",
    "Ld",
    "PhaseScriptExecution",
    "CodeSign",
    "Copy",
    "ProcessInfoPlistFile",
    "CompileAssetCatalog",
    "CompileAssetCatalogVariant",
    "CompileStoryboard",
    "CompileXIB",
    "Validate",
  ]);
  return [
    ...stripVTControlCharacters(output).matchAll(
      /^\s*([A-Za-z ]+) \((\d+) tasks?\) \| ([\d.]+) seconds\s*$/gmu,
    ),
  ]
    .flatMap(([, name = "", count, value]) => {
      const task = name.trim();
      const seconds = Number(value);
      return tasks.has(task) && Number.isFinite(seconds)
        ? [{ task, tasks: Number(count), seconds }]
        : [];
    })
    .slice(-32);
}

export function summarizeGatewayLanes(value: unknown) {
  if (!value || typeof value !== "object") {
    return { outcome: "unavailable" as const };
  }
  const fields = value as Record<string, unknown>;
  const count = (input: unknown) =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0;
  const rows = (input: unknown): Record<string, unknown>[] =>
    Array.isArray(input)
      ? input
          .slice(0, 100)
          .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      : [];
  const lanes = rows(fields.lanes);
  const dynamic = rows([fields.dynamic])[0];
  return {
    outcome: "captured" as const,
    workerCount: count(fields.workerCount),
    workerPoolCount: count(fields.workerPoolCount),
    pooledWorkerCount: rows(fields.workerPools).reduce(
      (sum, row) => sum + count(row.workerCount),
      0,
    ),
    activeCount: lanes.reduce((sum, row) => sum + count(row.activeCount), 0),
    queuedCount: lanes.reduce((sum, row) => sum + count(row.queuedCount), 0),
    maxConcurrent: lanes.reduce((sum, row) => sum + count(row.maxConcurrent), 0),
    drainingLaneCount: lanes.filter((row) => row.draining === true).length,
    ...(dynamic
      ? {
          dynamic: {
            laneCount: count(dynamic.laneCount),
            activeCount: count(dynamic.activeCount),
            queuedCount: count(dynamic.queuedCount),
            queuedLaneCount: count(dynamic.queuedLaneCount),
          },
        }
      : {}),
  };
}

// Diagnostic artifacts carry only these projections, never fixture logs or command output.
export function summarizeGatewayLogs(text: string): GatewayLogEvent[] {
  const events: GatewayLogEvent[] = [];
  for (const line of stripVTControlCharacters(text.slice(-128 * 1024)).split("\n")) {
    const rpc =
      /\b(req|res)\s+(?:[✓✗]\s+)?device\.pair\.(setupStatus|setupCode)\b(?:\s+(\d+)ms)?/u.exec(
        line,
      );
    if (rpc) {
      events.push({
        event: `${rpc[2] === "setupStatus" ? "setup-status" : "setup-code"}-${rpc[1] === "req" ? "received" : "responded"}`,
        ...(rpc[3] ? { durationMs: Number(rpc[3]) } : {}),
      });
    }
    if (line.includes("SQLite worker admission delayed")) {
      const fields: GatewayLogEvent = { event: "sqlite-worker-admission-delayed" };
      for (const key of ["queueDepth", "waitMs"] as const) {
        const value = new RegExp(`\\b${key}["']?\\s*[:=]\\s*(\\d+)`, "u").exec(line)?.[1];
        if (value) {
          fields[key] = Number(value);
        }
      }
      events.push(fields);
    }
    if (line.includes("memory pressure: level=critical")) {
      events.push({ event: "memory-critical" });
    }
    const delayedHeartbeat = /liveness heartbeat delayed: overdue=(\d+)ms elapsed=(\d+)ms/u.exec(
      line,
    );
    if (delayedHeartbeat) {
      events.push({
        event: "liveness-heartbeat-delayed",
        overdueMs: Number(delayedHeartbeat[1]),
        elapsedMs: Number(delayedHeartbeat[2]),
      });
    }
    const markers = [
      ["Idle shared-state worker retirement failed", "state-worker-idle-retirement-failed"],
      ["Shared-state worker retirement failed", "state-worker-retirement-failed"],
      ["service child cleanup identity lost:", "process-cleanup-identity-lost"],
      [
        "gateway process cleanup could not verify termination and output closure",
        "gateway-cleanup-unconfirmed",
      ],
      [
        "service child relay required forced retirement; cleanup completed",
        "process-cleanup-forced-retirement-completed",
      ],
    ] as const;
    for (const [marker, event] of markers) {
      if (line.includes(marker)) {
        events.push({ event });
      }
    }
    if (line.includes("service child cleanup did not complete before its hard deadline")) {
      const pending: Record<string, boolean> = {};
      for (const key of [
        "closingReceipt",
        "controlClose",
        "relayExit",
        "lineageEof",
        "extinctionUnconfirmed",
        "stdoutEnd",
        "stderrEnd",
      ]) {
        const value = new RegExp(`"${key}"\\s*:\\s*(true|false)`, "u").exec(line)?.[1];
        if (value) {
          pending[key] = value === "true";
        }
      }
      events.push({ event: "process-cleanup-deadline", pending });
    }
  }
  return events.slice(-32);
}

function observe(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 3_500, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

function summarizeSample(text: string) {
  const frameCounts = { sqlite: 0, filesystem: 0, locks: 0, poll: 0, v8: 0, node: 0, other: 0 };
  let frameCount = 0;
  for (const line of text.split("\n")) {
    if (!/^\s*[+!|:\s]*\d+\s+.+\(in /u.test(line)) {
      continue;
    }
    frameCount++;
    if (/sqlite/iu.test(line)) {
      frameCounts.sqlite++;
    } else if (/\b(?:read|write|pread|pwrite|open|stat|fsync|fcntl)|uv__fs/iu.test(line)) {
      frameCounts.filesystem++;
    } else if (/mutex|semaphore|ulock|condition|pthread_cond|__psynch/iu.test(line)) {
      frameCounts.locks++;
    } else if (/kevent|epoll|uv__io_poll|mach_msg/iu.test(line)) {
      frameCounts.poll++;
    } else if (/v8::|Builtin_|InterpreterEntry|Compile/iu.test(line)) {
      frameCounts.v8++;
    } else if (/node::|\(in node\)/iu.test(line)) {
      frameCounts.node++;
    } else {
      frameCounts.other++;
    }
  }
  return { outcome: "captured" as const, frameCount, frameCounts };
}

export async function collectGatewayProcessDiagnostics(
  pid?: number,
  options: { sample?: boolean } = {},
) {
  const host = { freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), loadAverage: loadavg() };
  const validPid = Number.isSafeInteger(pid) && pid !== undefined && pid > 0;
  const [processOutput, sampleOutput] = await Promise.all([
    validPid ? observe("/bin/ps", ["-p", String(pid), "-o", "%cpu=,rss=,state="]) : undefined,
    validPid && options.sample && platform() === "darwin"
      ? observe("/usr/bin/sample", [String(pid), "1", "1", "-file", "/dev/stdout"])
      : undefined,
  ]);
  const fields = processOutput?.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+)\s+([A-Z][A-Za-z+<>-]*)$/u);
  const state = fields?.[3]?.[0];
  return {
    host,
    process: fields
      ? {
          outcome: "captured" as const,
          cpuPercent: Number(fields[1]),
          rssBytes: Number(fields[2]) * 1024,
          // Only the primary BSD process state matters; flags and text are discarded.
          state: state && ["I", "R", "S", "T", "U", "Z"].includes(state) ? state : "other",
        }
      : { outcome: "unavailable" as const },
    ...(options.sample
      ? {
          sample: sampleOutput
            ? summarizeSample(sampleOutput)
            : { outcome: "unavailable" as const },
        }
      : {}),
  };
}
