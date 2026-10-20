import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const intervalMs = 15_000;
const maxOutputBytes = 4 * 1024 * 1024;
const qualificationPhases = [
  "source-head",
  "source-status",
  "xcode-version",
  "simslim-version",
  "simulator-runtime",
  "gateway-install",
  "gateway-preflight",
  "native-generate",
  "native-build",
  "native-build-reuse",
  "simulator-create",
  "simulator-boot",
  "simulator-ready",
  "simulator-slim",
  "simulator-delete",
  "fixture-server",
  "gateway-start",
  "setup-status",
  "setup-code",
  "native-test",
  "app-diagnostics",
  "provider-rpc",
  "test-results",
  "simulator-measure",
  "cleanup",
];
const phases = new Set([
  ...qualificationPhases.map((phase) => `qualification-${phase}`),
  "release-prepare",
  "release-build",
  "release-screenshots",
  "release-archive",
  "release-export",
  "release-metadata",
  "release-upload",
  "release-stage",
  "qualification-live-chat",
  "qualification-reader",
  ...["iphone", "ipad", "watch", "all"].flatMap((device) =>
    [
      "build",
      "create",
      "boot",
      "shutdown",
      "delete",
      "status-bar",
      "watch-capture",
      "capture-01-control-connected",
      "capture-02-chat-connected",
      "capture-03-agent-connected",
      "capture-04-settings-connected",
    ].map((operation) => `screenshot-${device}-${operation}`),
  ),
]);
const roles = new Set([
  "node",
  "bun",
  "ruby",
  "bash",
  "sh",
  "zsh",
  "git",
  "xcodebuild",
  "XCBBuildService",
  "swift-frontend",
  "swift-driver",
  "swift",
  "swiftc",
  "clang",
  "clang++",
  "ld",
  "actool",
  "ibtoold",
  "metal",
  "metallib",
  "Simulator",
  "SimulatorTrampoline",
  "simulatord",
  "CoreSimulatorService",
  "com.apple.CoreSimulator.CoreSimulatorService",
  "SimulatorBridge",
  "launchd_sim",
  "SpringBoard",
  "backboardd",
  "runningboardd",
  "launchd",
  "WindowServer",
  "kernel_task",
  "logd",
  "mds",
  "mds_stores",
  "mdworker_shared",
  "testmanagerd",
  "xctest",
  "OpenClaw",
  "OpenClawUITests-Runner",
]);

/** Callers supply fixed phase labels, never test names, paths, or application content. */
export function markIosResourcePhase(label) {
  const file = process.env.OPENCLAW_IOS_RESOURCE_PHASE_PATH;
  if (file) {
    try {
      writeFileSync(file, phases.has(label) ? label : "other");
    } catch {
      /* Optional diagnostics. */
    }
  }
}

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    for (const [key, value] of Object.entries(cpu.times)) {
      sum[key] = (sum[key] ?? 0) + value;
    }
    return sum;
  }, {});
}

function delta(current, previous) {
  return previous === undefined ? null : Math.max(0, current - previous);
}

function processRows(output, previous, elapsedMs) {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d:.-]+)\s+(\d+)\s+([A-Za-z+<>=-]+)\s+(.+)$/u.exec(line);
    if (!match) {
      return [];
    }
    const [, pid, ppid, time, rss, state, command] = match;
    const [day, clock] = time.includes("-") ? time.split("-") : ["0", time];
    const cpuMs =
      (Number(day) * 86_400 + clock.split(":").reduce((s, n) => s * 60 + Number(n), 0)) * 1_000;
    const cpuDeltaMs = delta(cpuMs, previous.get(Number(pid)));
    const basename = path.basename(command.trim());
    return [
      {
        pid: Number(pid),
        parentPid: Number(ppid),
        role: roles.has(basename) ? basename : "other",
        state,
        rssBytes: Number(rss) * 1024,
        cpuMs,
        cpuDeltaMs,
        cpuPercent:
          cpuDeltaMs === null ? null : Math.round((cpuDeltaMs / elapsedMs) * 10_000) / 100,
      },
    ];
  });
}

function memory(output) {
  const pageBytes = Number(/page size of (\d+) bytes/u.exec(output)?.[1]);
  if (!pageBytes) {
    return null;
  }
  const fields = Object.fromEntries(
    [...output.matchAll(/^([^:\n]+):\s+(\d+)\./gmu)].map((m) => [m[1], Number(m[2]) * pageBytes]),
  );
  return Object.fromEntries(
    Object.entries({
      freeBytes: "Pages free",
      activeBytes: "Pages active",
      inactiveBytes: "Pages inactive",
      wiredBytes: "Pages wired down",
      compressedResidentBytes: "Pages occupied by compressor",
      compressedLogicalBytes: "Pages stored in compressor",
      compressionsBytes: "Compressions",
      decompressionsBytes: "Decompressions",
      pageinsBytes: "Pageins",
      pageoutsBytes: "Pageouts",
      swapinsBytes: "Swapins",
      swapoutsBytes: "Swapouts",
    }).flatMap(([key, name]) => (fields[name] === undefined ? [] : [[key, fields[name]]])),
  );
}

function disks(output) {
  const lines = output.trim().split("\n");
  const names = lines[0]?.trim().split(/\s+/u) ?? [];
  const values = lines.at(-1)?.trim().split(/\s+/u).map(Number) ?? [];
  if (values.length !== names.length * 3 || values.some((n) => !Number.isFinite(n))) {
    return [];
  }
  return names.flatMap((name, index) =>
    /^disk\d+$/u.test(name)
      ? [
          {
            device: name,
            transfers: values[index * 3 + 1],
            bytes: Math.round(values[index * 3 + 2] * 1024 * 1024),
          },
        ]
      : [],
  );
}

function startTimeline(output) {
  let phaseDir;
  try {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, "", { mode: 0o600 });
    phaseDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-resource-"));
  } catch {
    return null;
  }
  const phaseFile = path.join(phaseDir, "phase");
  let active = true,
    bytes = 0,
    samples = 0,
    commandWallMs = 0,
    unavailableProbes = 0,
    outputLimitReached = false;
  let probeStatus = {};
  let timer, pending;
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  let previousCpu = cpuTimes(),
    previousProcesses = new Map(),
    previousMemory,
    previousDisks = new Map();
  let previousAt = started;
  let previousProcessAt = started;
  const phase = () => {
    try {
      const value = readFileSync(phaseFile, "utf8").trim();
      return phases.has(value) ? value : "other";
    } catch {
      return "startup";
    }
  };
  const overhead = () => ({
    elapsedMs: Math.round(performance.now() - started),
    samples,
    commandWallMs: Math.round(commandWallMs),
    unavailableProbes,
    nodeCpuMicros: process.cpuUsage(cpuStart),
    nodeRssBytes: process.memoryUsage().rss,
    nodeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
  });
  const emit = (record) => {
    const line = `${JSON.stringify(record)}\n`;
    // Keep room for the final workload outcome if a long run fills the sample budget.
    const budget = record.type === "end" ? maxOutputBytes : maxOutputBytes - 4096;
    if (bytes + Buffer.byteLength(line) > budget) {
      active = false;
      outputLimitReached = true;
      return;
    }
    try {
      appendFileSync(output, line);
      bytes += Buffer.byteLength(line);
    } catch {
      active = false;
    }
  };
  const probe = (command, args = []) =>
    new Promise((resolve) => {
      if (!active) {
        resolve("");
        return;
      }
      const at = performance.now();
      // Only observation subprocesses are deprioritized; the wrapped workload is unchanged.
      pending = execFile(
        "/usr/bin/nice",
        ["-n", "10", command, ...args],
        {
          timeout: 2_000,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
        },
        (error, stdout) => {
          pending = undefined;
          const wallMs = performance.now() - at;
          commandWallMs += wallMs;
          probeStatus[path.basename(command)] = {
            wallMs: Math.round(wallMs),
            outcome: !error
              ? "ok"
              : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "output-limit"
                : error.killed
                  ? "timeout"
                  : "unavailable",
          };
          if (error) {
            unavailableProbes += 1;
          }
          resolve(error ? "" : stdout);
        },
      );
    });
  async function sample() {
    const at = performance.now();
    const startedAt = new Date().toISOString();
    const phaseAtStart = phase();
    probeStatus = {};
    const vm = memory(await probe("/usr/bin/vm_stat"));
    const pressure = await probe("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    const diskRows = disks(await probe("/usr/sbin/iostat", ["-Id"]));
    const processOutput = await probe("/bin/ps", ["-axo", "pid=,ppid=,time=,rss=,state=,comm="]);
    // Earlier probes can stall independently of the interval between process CPU observations.
    const processAt = performance.now();
    const rows = processRows(processOutput, previousProcesses, processAt - previousProcessAt);
    if (!active) {
      return;
    }
    const cpu = cpuTimes();
    const cpuDeltas = Object.fromEntries(
      Object.keys(cpu).map((key) => [key, delta(cpu[key], previousCpu[key])]),
    );
    const total = Object.values(cpuDeltas).reduce((sum, n) => sum + n, 0);
    const topCpu = rows.toSorted((a, b) => (b.cpuDeltaMs ?? 0) - (a.cpuDeltaMs ?? 0)).slice(0, 6);
    const topMemory = rows.toSorted((a, b) => b.rssBytes - a.rssBytes).slice(0, 6);
    const selected = [...new Map([...topCpu, ...topMemory].map((row) => [row.pid, row])).values()];
    samples += 1;
    emit({
      type: "sample",
      startedAt,
      phaseAtStart,
      at: new Date().toISOString(),
      phase: phase(),
      intervalMs: samples === 1 ? null : Math.round(at - previousAt),
      sampleWallMs: Math.round(performance.now() - at),
      probes: probeStatus,
      host: {
        cpuPercent:
          samples === 1
            ? null
            : Object.fromEntries(
                Object.entries(cpuDeltas).map(([key, value]) => [
                  key,
                  total ? Math.round((value / total) * 10_000) / 100 : null,
                ]),
              ),
        load: os.loadavg(),
        memory: vm,
        pressureLevel: /^[124]\s*$/u.test(pressure) ? Number(pressure) : null,
        memoryDelta:
          vm && previousMemory
            ? Object.fromEntries(
                [
                  "compressionsBytes",
                  "decompressionsBytes",
                  "pageinsBytes",
                  "pageoutsBytes",
                  "swapinsBytes",
                  "swapoutsBytes",
                ].map((key) => [key, delta(vm[key], previousMemory[key])]),
              )
            : null,
        disks: diskRows.map((disk) => ({
          ...disk,
          transfersDelta: delta(disk.transfers, previousDisks.get(disk.device)?.transfers),
          bytesDelta: delta(disk.bytes, previousDisks.get(disk.device)?.bytes),
        })),
      },
      processes: selected,
      collector: overhead(),
    });
    previousAt = at;
    previousProcessAt = processAt;
    previousCpu = cpu;
    previousMemory = vm;
    previousDisks = new Map(diskRows.map((disk) => [disk.device, disk]));
    previousProcesses = new Map(rows.map((row) => [row.pid, row.cpuMs]));
    // Delayed collection skips missed slots; there is never a catch-up queue.
    if (active) {
      timer = setTimeout(collect, intervalMs);
    }
  }
  const collect = () => {
    void sample().catch(() => {
      active = false;
      emit({ type: "unavailable", at: new Date().toISOString() });
    });
  };
  emit({
    type: "start",
    at: new Date().toISOString(),
    intervalMs,
    maxOutputBytes,
    cpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    nativeProbes: process.platform === "darwin",
    collectorCpuScope: "node-only-excludes-observation-subprocesses",
  });
  if (process.platform === "darwin") {
    collect();
  }
  return {
    phaseFile,
    stop(code, signal) {
      active = false;
      clearTimeout(timer);
      pending?.kill("SIGKILL");
      // Do not await native probes at workload completion, even if the host is overloaded.
      emit({
        type: "end",
        at: new Date().toISOString(),
        phase: phase(),
        code,
        signal,
        outputLimitReached,
        collector: overhead(),
      });
      try {
        rmSync(phaseDir, { recursive: true, force: true });
      } catch {
        /* Optional diagnostics. */
      }
    },
  };
}

function main() {
  const [option, output, separator, command, ...args] = process.argv.slice(2);
  if (option !== "--output" || !output || separator !== "--" || !command) {
    process.stderr.write(
      "Usage: node scripts/ios-resource-timeline.mjs --output PATH -- COMMAND [ARGS...]\n",
    );
    process.exitCode = 2;
    return;
  }
  let timeline;
  if (process.env.OPENCLAW_IOS_RESOURCE_DIAGNOSTICS !== "0") {
    try {
      timeline = startTimeline(output);
    } catch {
      /* Diagnostics must not prevent a workload. */
    }
    if (!timeline) {
      process.stderr.write(
        "[ios-resource-timeline] Diagnostics unavailable; continuing workload.\n",
      );
    }
  }
  const env = { ...process.env };
  delete env.OPENCLAW_IOS_RESOURCE_PHASE_PATH;
  if (timeline) {
    env.OPENCLAW_IOS_RESOURCE_PHASE_PATH = timeline.phaseFile;
  }
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    detached: process.platform !== "win32",
  });
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
      const handler = () => {
        if (child.pid === undefined) {
          return;
        }
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
        } catch {
          /* Child already exited. */
        }
      };
      process.on(signal, handler);
      return [signal, handler];
    }),
  );
  let finished = false;
  const finish = (code, signal) => {
    if (finished) {
      return;
    }
    finished = true;
    timeline?.stop(code, signal);
    for (const [name, handler] of handlers) {
      process.off(name, handler);
    }
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  };
  child.once("error", () => {
    process.stderr.write("[ios-resource-timeline] Unable to start wrapped workload.\n");
    finish(127, null);
  });
  child.once("exit", finish);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
