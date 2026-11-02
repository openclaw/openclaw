#!/usr/bin/env node
// Temporary screenshot diagnostic. No application behavior or test assertions change.
import { execFile } from "node:child_process";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = "[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}";
const roleNames = { app: "OpenClaw", runner: "OpenClawUITests-Runner" };
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

export function validIdentity(row, pid, role, simulator) {
  return (
    new RegExp(`^${UUID}$`).test(simulator ?? "") &&
    row?.pid === pid &&
    row.name === roleNames[role] &&
    row.ppid > 1 &&
    row.executable.toLowerCase().includes(`/CoreSimulator/Devices/${simulator}/`.toLowerCase())
  );
}

export function parseReceipt(text, simulator) {
  try {
    const receipt = JSON.parse(text);
    return receipt.role === "app" &&
      Number.isSafeInteger(receipt.pid) &&
      receipt.pid > 1 &&
      typeof receipt.simulator === "string" &&
      receipt.simulator.toUpperCase() === simulator
      ? receipt.pid
      : undefined;
  } catch {
    return undefined;
  }
}

export function runnerPid(line) {
  const match = line.match(/OpenClawUITests-Runner\[(\d+):\d+\]/);
  const pid = match ? +match[1] : undefined;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
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

function bounded(promise, timeoutMs, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createObserver(privateDir, execute = execFile) {
  const children = new Map();
  const unjoined = new Map();
  const parents = new Set();
  let closed = false;
  function command(executable, args, timeoutMs, role = "process-scan") {
    if (closed) return Promise.resolve({ outcome: "stopped", wallMs: 0, stdout: "" });
    const started = performance.now();
    const state = {};
    state.done = new Promise((resolve) => {
      let child;
      let settled = false;
      let cancelled;
      let timeout, hardKill, abandonment;
      const finish = (error, stdout = "", detached = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(hardKill);
        clearTimeout(abandonment);
        children.delete(child);
        if (detached) {
          if (child.exitCode == null && child.signalCode == null && child.pid) {
            unjoined.set(child.pid, { pid: child.pid, role });
          }
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        }
        resolve({
          outcome: cancelled ?? (error ? "unavailable" : "ok"),
          wallMs: round(performance.now() - started),
          stdout: error || cancelled ? "" : stdout,
        });
      };
      const kill = (signal) => {
        try {
          child.kill(signal);
        } catch {}
      };
      state.abandon = () => finish(true, "", true);
      state.cancel = (outcome) => {
        if (settled || cancelled) return;
        cancelled = outcome;
        kill("SIGTERM");
        hardKill = setTimeout(() => kill("SIGKILL"), 300);
        // Native exit notification may itself stop under severe host pressure.
        abandonment = setTimeout(state.abandon, 600);
      };
      child = execute(
        executable,
        args,
        {
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
        },
        (error, stdout) => {
          unjoined.delete(child?.pid);
          finish(error, stdout);
        },
      );
      children.set(child, state);
      timeout = setTimeout(() => state.cancel("timeout"), timeoutMs);
    });
    return state.done;
  }
  return {
    async observe(pid, role, simulator) {
      const started = performance.now();
      const result = await command(
        "/bin/ps",
        ["-ww", "-p", String(pid), "-o", "pid=,ppid=,time=,rss=,state=,comm="],
        1000,
      );
      const row = parseProcesses(result.stdout).find((value) =>
        validIdentity(value, pid, role, simulator),
      );
      if (!row)
        return {
          outcome: result.outcome === "ok" ? "invalid-identity" : result.outcome,
          wallMs: result.wallMs,
        };
      if (!parents.has(row.ppid)) {
        const parent = await command(
          "/bin/ps",
          ["-ww", "-p", String(row.ppid), "-o", "pid=,ppid=,time=,rss=,state=,comm="],
          1000,
          "parent-check",
        );
        if (
          !parseProcesses(parent.stdout).some(
            (value) => value.pid === row.ppid && value.name === "launchd_sim",
          )
        ) {
          return {
            outcome: parent.outcome === "ok" ? "invalid-parent" : parent.outcome,
            wallMs: round(performance.now() - started),
          };
        }
        parents.add(row.ppid);
      }
      return {
        outcome: "ok",
        wallMs: round(performance.now() - started),
        row: { ...row, role, simulator },
      };
    },
    async sample(row, index) {
      if (!validIdentity(row, row.pid, row.role, row.simulator)) {
        return { role: row.role, pid: row.pid, outcome: "invalid-identity", wallMs: 0 };
      }
      // Recheck the executable and parent immediately before attaching. A PID alone is not custody.
      const identity = await command(
        "/bin/ps",
        ["-ww", "-p", String(row.pid), "-o", "pid=,ppid=,time=,rss=,state=,comm="],
        1000,
        "identity-check",
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
        `sample-${row.role}`,
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
      const pending = [...children.values()];
      for (const state of pending) state.cancel("stopped");
      await bounded(Promise.all(pending.map((state) => state.done)), 800);
      for (const state of children.values()) state.abandon();
      return { unjoined: [...unjoined.values()] };
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
  const previous = new Map();
  const pids = new Map();
  const verified = new Map();
  let previousCpu;
  let nextHostAt = 0;
  let receiptStatus;
  const disabledRoles = new Set();
  let sampleCount = 0;
  let bursts = 0;
  let lastBurstAt = -Infinity;
  let sampling;
  const failedPids = new Set();
  const emit = (event) => {
    if (events.length < 4000) events.push({ atMs: round(performance.now() - started), ...event });
  };
  const ownResources = () => {
    const cpu = process.cpuUsage();
    return {
      userCpuMs: round(cpu.user / 1000),
      systemCpuMs: round(cpu.system / 1000),
      rssBytes: process.memoryUsage.rss(),
    };
  };
  let closing;
  const closeObserver = () =>
    (closing ??= Promise.resolve(observer.close()).then(
      (result) => result ?? { unjoined: [] },
      () => ({ unjoined: [] }),
    ));
  const writeOutput = (checkpoint = false) =>
    writeFileSync(
      options.output,
      `${JSON.stringify({ schemaVersion: 1, diagnosticOnly: true, checkpoint, events }, null, 2)}\n`,
      { mode: 0o600 },
    );
  const onSignal = () => {
    reason = "signal";
    stopped = true;
    emit({ event: "shutdown-requested" });
    try {
      writeOutput(true);
    } catch {}
    closeObserver();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  await fs.mkdir(options.privateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(options.privateDir, 0o700);
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  emit({ event: "probe-start", observerOwn: ownResources() });
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
              const runner = runnerPid(line);
              if (runner && pids.get("runner") !== runner) {
                pids.set("runner", runner);
                verified.delete("runner");
                disabledRoles.delete("runner");
                emit({ event: "runner-identified", role: "runner", pid: runner });
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
      if (!stopped && chatAt !== undefined && simulator) {
        try {
          const receiptPath = path.join(options.receiptDir, `${simulator}.json`);
          const info = await fs.lstat(receiptPath);
          if (!info.isFile() || info.size > 1024) throw new Error("invalid receipt");
          const pid = parseReceipt(await fs.readFile(receiptPath, "utf8"), simulator);
          if (!pid) throw new Error("invalid receipt");
          if (pids.get("app") !== pid) {
            pids.set("app", pid);
            verified.delete("app");
            disabledRoles.delete("app");
            emit({ event: "app-receipt", role: "app", pid });
          }
          receiptStatus = "ok";
        } catch (error) {
          const status = error.code === "ENOENT" ? "missing" : "invalid";
          if (receiptStatus !== status) emit({ event: "app-receipt-unavailable", reason: status });
          receiptStatus = status;
          pids.delete("app");
          verified.delete("app");
        }
      }
      if (!stopped && chatAt !== undefined && at >= nextHostAt) {
        const cpu = os.cpus().reduce(
          (totals, core) => {
            totals.idle += core.times.idle;
            totals.total += Object.values(core.times).reduce((sum, value) => sum + value, 0);
            return totals;
          },
          { idle: 0, total: 0 },
        );
        const cpuDelta = previousCpu ? cpu.total - previousCpu.total : 0;
        emit({
          event: "host-observation",
          freeMemoryBytes: os.freemem(),
          totalMemoryBytes: os.totalmem(),
          loadAverage: os.loadavg(),
          ...(cpuDelta > 0
            ? { busyCpuPercent: round(100 * (1 - (cpu.idle - previousCpu.idle) / cpuDelta)) }
            : {}),
        });
        previousCpu = cpu;
        nextHostAt = performance.now() + 1000;
      }
      if (!stopped && chatAt !== undefined && simulator && at >= nextPsAt) {
        for (const [role, pid] of pids) {
          if (disabledRoles.has(role)) continue;
          const result = await observer.observe(pid, role, simulator);
          const observedAt = performance.now();
          const row = result.row;
          const before = previous.get(pid);
          const intervalMs = before ? observedAt - before.at : undefined;
          if (row) {
            verified.set(role, row);
            previous.set(pid, { cpuMs: row.cpuMs, at: observedAt });
          }
          emit({
            event: "process-observation",
            role,
            pid,
            outcome: result.outcome,
            wallMs: result.wallMs,
            ...(intervalMs === undefined ? {} : { intervalMs: round(intervalMs) }),
            ...(row
              ? {
                  cpuMs: row.cpuMs,
                  rssBytes: row.rssBytes,
                  state: row.state,
                  ...(intervalMs
                    ? {
                        cpuPercent: round(
                          (Math.max(0, row.cpuMs - before.cpuMs) / intervalMs) * 100,
                        ),
                      }
                    : {}),
                }
              : {}),
          });
          if (result.outcome !== "ok" || result.wallMs > 1000) {
            disabledRoles.add(role);
            emit({
              event: "process-observation-disabled",
              role,
              reason: result.outcome === "ok" ? "observation-budget" : result.outcome,
            });
          }
        }
        nextPsAt = performance.now() + 1000;
      }
      if (
        !stopped &&
        focusAt !== undefined &&
        !sampling &&
        bursts < 2 &&
        sampleCount < 4 &&
        performance.now() - lastActivityAt >= 2000 &&
        performance.now() - lastBurstAt >= 8000
      ) {
        const targets = ["app", "runner"]
          .map((role) => verified.get(role))
          .filter((row) => row && !failedPids.has(row.pid))
          .slice(0, 4 - sampleCount);
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
    const cleanup = await bounded(closeObserver(), 1000, { unjoined: [], deadline: true });
    const samplingJoined = await bounded(
      Promise.resolve(sampling).then(() => true),
      1000,
      false,
    );
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    emit({
      event: "probe-end",
      reason,
      sampleCommands: sampleCount,
      samplingJoined,
      ...(cleanup.deadline ? { cleanupDeadline: true } : {}),
      nativeChildrenUnjoined: cleanup.unjoined,
      nativeChildCount: cleanup.unjoined.length,
      observerOwn: ownResources(),
      missingRoles: ["app", "runner"].filter((role) => !verified.has(role)),
    });
    writeOutput();
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
    "--receipt-dir": "receiptDir",
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
    !options.receiptDir ||
    (options.simulator && !new RegExp(`^${UUID}$`).test(options.simulator))
  ) {
    process.stderr.write(
      "Usage: ios-ax-diagnostic.mjs --log-dir DIR --output FILE --private-dir DIR --receipt-dir DIR [--simulator UUID]\n",
    );
    process.exit(2);
  }
  runProbe(options)
    .then(() => process.exit(0))
    .catch(() => {
      process.stderr.write("Diagnostic output unavailable.\n");
      process.exit(1);
    });
}
