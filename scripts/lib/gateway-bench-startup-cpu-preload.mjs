import assert from "node:assert/strict";
import { Console } from "node:console";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";

const owner = new URL(import.meta.url);
// Forks can inherit --import; only the owned Gateway main isolate observes output.
if (
  isMainThread &&
  process.ppid === Number(owner.searchParams.get("parentPid")) &&
  process.argv[1] === owner.searchParams.get("entry")
) {
  const attachment = owner.searchParams.get("attachment");
  assert.ok(attachment);
  const attachedMonotonicUs = Number(process.hrtime.bigint() / 1_000n);
  const attachedPerformanceMs = performance.now();
  const phases = [];
  const observerErrors = [];
  let droppedPhases = 0;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    let carry = "";
    stream.write = function (chunk, ...args) {
      try {
        const text =
          typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
        const lines = (carry + text).split("\n");
        carry = (lines.pop() ?? "").slice(-4096);
        for (const line of lines) {
          const match = /startup trace: ([^ ]+) ([0-9.]+)ms total=([0-9.]+)ms/u.exec(line);
          if (!match) {
            continue;
          }
          if (phases.length < 512) {
            const start = /\bstart=([0-9.]+)ms/u.exec(line);
            const calls = /\bcalls=([0-9]+)/u.exec(line);
            phases.push({
              phase: match[1],
              durationMs: Number(match[2]),
              totalMs: Number(match[3]),
              ...(start ? { startMs: Number(start[1]) } : {}),
              ...(calls ? { calls: Number(calls[1]) } : {}),
              monotonicUs: Number(process.hrtime.bigint() / 1_000n),
              performanceMs: performance.now(),
            });
          } else {
            droppedPhases++;
          }
        }
      } catch (error) {
        if (observerErrors.length < 8) {
          observerErrors.push(String(error));
        }
      }
      return original(chunk, ...args);
    };
  }
  if (process.versions.bun) {
    // Bun's native console bypasses stream.write; use the same observed streams
    // for console methods captured later by the Gateway's logging owner.
    const outputConsole = new Console({ stdout: process.stdout, stderr: process.stderr });
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      console[method] = outputConsole[method];
    }
  }
  process.once("exit", (code) => {
    writeFileSync(
      attachment,
      `${JSON.stringify(
        {
          pid: process.pid,
          parentPid: process.ppid,
          mainThread: isMainThread,
          threadId,
          entry: process.argv[1],
          execArgv: process.execArgv,
          attachedMonotonicUs,
          attachedPerformanceMs,
          timeOrigin: performance.timeOrigin,
          exitedMonotonicUs: Number(process.hrtime.bigint() / 1_000n),
          code,
          phases,
          droppedPhases,
          observerErrors,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  });
}
