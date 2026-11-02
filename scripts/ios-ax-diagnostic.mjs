#!/usr/bin/env node
// Temporary screenshot diagnostic. No application behavior or test assertions change.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = "[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}";
const roles = new Map([
  ["OpenClaw", "app"],
  ["OpenClawUITests-Runner", "runner"],
  ["AXSpringBoardServer", "ax-server"],
  ["accessibilityd", "accessibility"],
  ["testmanagerd", "testmanager"],
  ["SpringBoard", "springboard"],
  ["backboardd", "backboard"],
  ["AXUIElement", "ax-ui-element"],
  ["AXUIService", "ax-ui-service"],
]);
const round = (value) => Math.round(value * 1000) / 1000;

export function parseProcesses(text) {
  return text.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return [];
    const clock = match[3].match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
    if (!clock) return [];
    return [
      {
        pid: +match[1],
        ppid: +match[2],
        cpuMs:
          (((+(clock[1] ?? 0) * 24 + +(clock[2] ?? 0)) * 60 + +clock[3]) * 60 + +clock[4]) * 1000,
        rssBytes: +match[4] * 1024,
        state: /^[IRSUTZ]/.test(match[5]) ? match[5][0] : "other",
        executable: match[6],
        name: path.basename(match[6]),
      },
    ];
  });
}

export function selectProcesses(rows, simulator) {
  if (!new RegExp(`^${UUID}$`).test(simulator ?? "")) return [];
  const devicePath = `/CoreSimulator/Devices/${simulator}/`.toLowerCase();
  const direct = rows.filter(
    (row) =>
      ["app", "runner"].includes(roles.get(row.name)) &&
      row.executable.toLowerCase().includes(devicePath),
  );
  // Device-local app paths establish custody; a matching service name alone never does.
  const roots = new Set(
    direct
      .map((row) => row.ppid)
      .filter((pid) => rows.some((row) => row.pid === pid && row.name === "launchd_sim")),
  );
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  function inDevice(row) {
    const seen = new Set();
    for (let depth = 0; depth < 12 && row && !seen.has(row.pid); depth++) {
      if (roots.has(row.ppid)) return true;
      seen.add(row.pid);
      row = byPid.get(row.ppid);
    }
    return false;
  }
  return rows
    .filter(
      (row) =>
        direct.includes(row) ||
        ([
          "ax-server",
          "accessibility",
          "testmanager",
          "springboard",
          "backboard",
          "ax-ui-element",
          "ax-ui-service",
        ].includes(roles.get(row.name)) &&
          inDevice(row)),
    )
    .map((row) => ({ ...row, role: roles.get(row.name) }));
}

function safeModule(name) {
  return (
    new Set([
      "OpenClaw",
      "OpenClaw.debug.dylib",
      "OpenClawUITests",
      "OpenClawUITests-Runner",
      "OpenClawKit",
      "OpenClawChatUI",
      "OpenClawProtocol",
      "CoreFoundation",
      "Foundation",
      "AttributeGraph",
      "QuartzCore",
      "CoreGraphics",
      "CoreText",
      "TextInput",
      "TextInputUI",
      "XCTest",
      "XCTestCore",
      "XCTestSupport",
      "XCUIAutomation",
      "XCTAutomationSupport",
      "testmanagerd",
      "accessibilityd",
      "AXSpringBoardServer",
      "dyld",
      "HIToolbox",
    ]).has(name) ||
    /^(?:lib(?:system|swift|objc|dispatch|c\+\+|dyld)|UIKit|SwiftUI|Accessibility|AX)[A-Za-z0-9_.+-]*$/.test(
      name,
    )
  );
}

export function sanitizeSample(text) {
  const threads = [];
  let current;
  let frameCount = 0;
  let inCallGraph = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "Call graph:") {
      inCallGraph = true;
      continue;
    }
    if (/^\s*(?:Binary Images:|Total number in stack|Sort by top of stack)/.test(line)) break;
    if (!inCallGraph) continue;
    if (/^\s*(?:\d+\s+)?Thread_\d+/.test(line)) {
      current = {
        index: threads.length,
        mainThread: line.includes("com.apple.main-thread"),
        frames: [],
      };
      threads.push(current);
      if (threads.length >= 128) break;
      continue;
    }
    const match = line.match(/^(\s*(?:[+!:|]\s*)*)(\d+)\s+(.+?)\s+\(in ([^)]+)\)/);
    if (!match || frameCount >= 2000) continue;
    const module = match[4];
    if (!safeModule(module)) continue;
    let symbol = match[3]
      .replace(/0x[0-9a-f]+/gi, "<address>")
      .replace(/https?:\/\/\S+/gi, "<url>")
      .replace(/\/(?:[^\s)]+)/g, "<path>")
      .replace(/"[^"\n]*"|'[^'\n]*'/g, "<quoted>")
      .slice(0, 320);
    if (!/^[\p{L}\p{N}_.:+#<>\[\](){}?!,~&*=$@ %\-]+$/u.test(symbol)) symbol = "<symbol>";
    if (!current) {
      current = { index: 0, mainThread: false, frames: [] };
      threads.push(current);
    }
    current.frames.push({ count: +match[2], depth: Math.min(64, match[1].length), module, symbol });
    frameCount++;
  }
  return { frameCount, threads };
}

export function classifyLine(line) {
  if (/Test Case .*testReleaseChatScreenshot.* started\./.test(line))
    return { event: "chat-start" };
  if (/Test Case .*testReleaseChatScreenshot.* (?:passed|failed) \(/.test(line))
    return { event: "chat-end", outcome: line.includes(" passed (") ? "passed" : "failed" };
  const match = line.match(/^\s*t =\s*(\d+(?:\.\d+)?)s\s+(.+)$/);
  if (!match) return undefined;
  const text = match[2];
  const event = text.startsWith("Type 'focus'")
    ? "type-focus"
    : text.startsWith("Type '")
      ? "type-other"
      : text.startsWith('Find the "chat-message-input"')
        ? "input-lookup"
        : text.startsWith('Find the "chat-transcript"')
          ? "transcript-lookup"
          : text.startsWith('Tap "chat-transcript"')
            ? "transcript-tap"
            : text.startsWith("Check for interrupting elements")
              ? "interrupt-check"
              : text.includes("Keyboard (First Match)")
                ? "keyboard-query"
                : text.includes('"Mermaid diagram"')
                  ? "diagram-query"
                  : text.includes('"Close diagram preview"')
                    ? "preview-query"
                    : text.startsWith("Wait for ")
                      ? "wait"
                      : text.startsWith("Synthesize event")
                        ? "synthesize"
                        : "activity";
  return { event, xctestSeconds: +match[1] };
}

export function createObserver(privateDir) {
  const children = new Set();
  let closed = false;
  async function command(executable, args, timeoutMs) {
    if (closed) return { outcome: "stopped", wallMs: 0, stdout: "" };
    const started = performance.now();
    return new Promise((resolve) => {
      const child = execFile(
        executable,
        args,
        {
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
        },
        (error, stdout) => {
          clearTimeout(timeout);
          clearTimeout(hardKill);
          children.delete(child);
          resolve({
            outcome: expired ? "timeout" : closed ? "stopped" : error ? "unavailable" : "ok",
            wallMs: round(performance.now() - started),
            stdout: error ? "" : stdout,
          });
        },
      );
      children.add(child);
      let expired = false;
      let hardKill;
      const timeout = setTimeout(() => {
        expired = true;
        child.kill("SIGTERM");
        hardKill = setTimeout(() => child.kill("SIGKILL"), 300);
      }, timeoutMs);
    });
  }
  return {
    async processes() {
      const result = await command(
        "/bin/ps",
        ["-ww", "-axo", "pid=,ppid=,time=,rss=,state=,comm="],
        1500,
      );
      return { ...result, rows: result.outcome === "ok" ? parseProcesses(result.stdout) : [] };
    },
    async sample(row, index) {
      // Recheck the executable and parent immediately before attaching. A PID alone is not custody.
      const identity = await command(
        "/bin/ps",
        ["-ww", "-p", String(row.pid), "-o", "pid=,ppid=,time=,rss=,state=,comm="],
        1000,
      );
      const current = parseProcesses(identity.stdout).find(
        (value) =>
          value.pid === row.pid && value.ppid === row.ppid && value.executable === row.executable,
      );
      if (!current)
        return {
          role: row.role,
          pid: row.pid,
          outcome: "identity-unavailable",
          wallMs: identity.wallMs,
        };
      const rawPath = path.join(privateDir, `sample-${index}.txt`);
      await fs.writeFile(rawPath, "", { flag: "wx", mode: 0o600 });
      const result = await command(
        "/usr/bin/sample",
        [String(row.pid), "1", "10", "-file", rawPath],
        3500,
      );
      let stack;
      if (result.outcome === "ok") {
        const info = await fs.stat(rawPath);
        if (info.size <= 2 * 1024 * 1024)
          stack = sanitizeSample(await fs.readFile(rawPath, "utf8"));
      }
      return {
        role: row.role,
        pid: row.pid,
        outcome: result.outcome,
        wallMs: result.wallMs,
        ...(stack ? { stack } : {}),
      };
    },
    async close() {
      closed = true;
      for (const child of children) child.kill("SIGTERM");
      const deadline = performance.now() + 350;
      while (children.size && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      for (const child of children) child.kill("SIGKILL");
      while (children.size) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}

export async function runProbe(options, observer = createObserver(options.privateDir)) {
  const started = performance.now();
  const events = [];
  let stopped = false;
  let reason = "wait-deadline";
  let simulator = options.simulator?.toUpperCase();
  let logPath;
  let offset = 0;
  let pendingLine = "";
  let chatAt;
  let focusAt;
  let lastActivityAt;
  let nextPsAt = 0;
  let previous = new Map();
  let previousAt;
  let previousCpu;
  let selected = [];
  let psDisabled = false;
  let sampleCount = 0;
  let bursts = 0;
  let lastBurstAt = -Infinity;
  let sampling;
  const failedPids = new Set();
  const emit = (event) => {
    if (events.length < 4000) events.push({ atMs: round(performance.now() - started), ...event });
  };
  const onSignal = () => {
    reason = "signal";
    stopped = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  await fs.mkdir(options.privateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(options.privateDir, 0o700);
  emit({ event: "probe-start" });
  try {
    while (!stopped && performance.now() - started < 30 * 60 * 1000) {
      const at = performance.now();
      if (!logPath) {
        const names = await fs
          .readdir(options.logDir)
          .catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
        const candidates = names.filter((name) => /^iPhone.*\.log$/.test(name));
        if (candidates.length > 1) {
          reason = "ambiguous-log";
          break;
        }
        if (candidates.length === 1) logPath = path.join(options.logDir, candidates[0]);
      }
      if (logPath) {
        let handle;
        try {
          handle = await fs.open(logPath, "r");
          const info = await handle.stat();
          if (!info.isFile()) {
            reason = "invalid-log";
            break;
          }
          if (info.size < offset) {
            reason = "log-truncated";
            break;
          }
          if (info.size - offset > 2 * 1024 * 1024) {
            reason = "log-read-limit";
            break;
          }
          if (info.size > offset) {
            const buffer = Buffer.alloc(info.size - offset);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            offset += bytesRead;
            const lines = (pendingLine + buffer.subarray(0, bytesRead).toString("utf8")).split(
              "\n",
            );
            pendingLine = lines.pop();
            for (const line of lines) {
              const destination = line.match(
                new RegExp(`platform=iOS Simulator,id=(${UUID})(?:["\\s]|$)`),
              );
              if (destination) {
                const found = destination[1].toUpperCase();
                if (simulator && found !== simulator) {
                  reason = "simulator-mismatch";
                  stopped = true;
                  break;
                }
                if (!simulator) {
                  simulator = found;
                  emit({ event: "simulator-identified" });
                }
              }
              const activity = classifyLine(line);
              if (activity?.event === "chat-start") {
                chatAt = performance.now();
                emit(activity);
              } else if (chatAt !== undefined && activity) {
                lastActivityAt = performance.now();
                emit(activity);
                if (activity.event === "type-focus") focusAt = performance.now();
                if (activity.event === "chat-end") {
                  reason = "chat-finished";
                  stopped = true;
                  break;
                }
              }
            }
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            reason = "log-unavailable";
            break;
          }
        } finally {
          await handle?.close();
        }
      }
      if (chatAt !== undefined && at - chatAt >= 120_000) {
        reason = "chat-deadline";
        break;
      }
      if (!stopped && chatAt !== undefined && simulator && !psDisabled && at >= nextPsAt) {
        const result = await observer.processes();
        const observedAt = performance.now();
        selected = selectProcesses(result.rows, simulator);
        const intervalMs = previousAt === undefined ? undefined : observedAt - previousAt;
        const cpu = os.cpus().reduce(
          (totals, core) => {
            totals.idle += core.times.idle;
            totals.total += Object.values(core.times).reduce((sum, value) => sum + value, 0);
            return totals;
          },
          { idle: 0, total: 0 },
        );
        const cpuDelta = previousCpu ? cpu.total - previousCpu.total : 0;
        const host = {
          freeMemoryBytes: os.freemem(),
          totalMemoryBytes: os.totalmem(),
          loadAverage: os.loadavg(),
          ...(cpuDelta > 0
            ? { busyCpuPercent: round(100 * (1 - (cpu.idle - previousCpu.idle) / cpuDelta)) }
            : {}),
        };
        emit({
          event: "process-observation",
          outcome: result.outcome,
          wallMs: result.wallMs,
          ...(intervalMs === undefined ? {} : { intervalMs: round(intervalMs) }),
          host,
          processes: selected.map((row) => ({
            role: row.role,
            pid: row.pid,
            cpuMs: row.cpuMs,
            rssBytes: row.rssBytes,
            state: row.state,
            ...(intervalMs && previous.has(row.pid)
              ? {
                  cpuPercent: round(
                    (Math.max(0, row.cpuMs - previous.get(row.pid)) / intervalMs) * 100,
                  ),
                }
              : {}),
          })),
        });
        previous = new Map(selected.map((row) => [row.pid, row.cpuMs]));
        previousCpu = cpu;
        previousAt = observedAt;
        nextPsAt = observedAt + 1000;
        if (result.outcome !== "ok" || result.wallMs > 1000) {
          psDisabled = true;
          emit({
            event: "process-observation-disabled",
            reason: result.outcome === "ok" ? "observation-budget" : "unavailable",
          });
        }
      }
      if (
        !stopped &&
        focusAt !== undefined &&
        !sampling &&
        !psDisabled &&
        bursts < 2 &&
        sampleCount < 4 &&
        performance.now() - lastActivityAt >= 2000 &&
        performance.now() - lastBurstAt >= 8000
      ) {
        const preferred =
          bursts === 0
            ? ["app", "runner"]
            : [
                "ax-server",
                "testmanager",
                "accessibility",
                "ax-ui-service",
                "ax-ui-element",
                "springboard",
                "backboard",
              ];
        let targets = preferred
          .map((role) => selected.find((row) => row.role === role))
          .filter(Boolean)
          .slice(0, 2);
        if (!targets.length && bursts > 0)
          targets = ["app", "runner"]
            .map((role) => selected.find((row) => row.role === role))
            .filter(Boolean);
        targets = targets.filter((row) => !failedPids.has(row.pid)).slice(0, 4 - sampleCount);
        if (targets.length) {
          bursts++;
          lastBurstAt = performance.now();
          emit({
            event: "sample-trigger",
            burst: bursts,
            gapMs: round(lastBurstAt - lastActivityAt),
            roles: targets.map((row) => row.role),
          });
          sampling = Promise.all(
            targets.map((row) => {
              const index = ++sampleCount;
              return observer
                .sample(row, index)
                .then((result) => {
                  if (result.outcome !== "ok") failedPids.add(row.pid);
                  emit({ event: "stack-sample", ...result });
                })
                .catch(() => {
                  failedPids.add(row.pid);
                  emit({
                    event: "stack-sample",
                    role: row.role,
                    pid: row.pid,
                    outcome: "unavailable",
                  });
                });
            }),
          ).finally(() => {
            sampling = undefined;
          });
        }
      }
      if (!stopped)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, 500 - (performance.now() - at))),
        );
    }
  } catch {
    reason = "probe-error";
  } finally {
    await observer.close();
    await sampling;
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    emit({ event: "probe-end", reason, sampleCommands: sampleCount });
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(
      options.output,
      `${JSON.stringify({ schemaVersion: 1, diagnosticOnly: true, events }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return { reason, events };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === (await fs.realpath(process.argv[1]).catch(() => undefined))
) {
  const options = {};
  const names = {
    "--log-dir": "logDir",
    "--output": "output",
    "--private-dir": "privateDir",
    "--simulator": "simulator",
  };
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = names[process.argv[index]];
    const value = process.argv[index + 1];
    if (!name || !value) {
      process.stderr.write("Invalid diagnostic arguments.\n");
      process.exit(2);
    }
    options[name] = value;
  }
  if (
    !options.logDir ||
    !options.output ||
    !options.privateDir ||
    (options.simulator && !new RegExp(`^${UUID}$`).test(options.simulator))
  ) {
    process.stderr.write(
      "Usage: ios-ax-diagnostic.mjs --log-dir DIR --output FILE --private-dir DIR [--simulator UUID]\n",
    );
    process.exit(2);
  }
  runProbe(options).catch(() => {
    process.stderr.write("Diagnostic output unavailable.\n");
    process.exitCode = 1;
  });
}
