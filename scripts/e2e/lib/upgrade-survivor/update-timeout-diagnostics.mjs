import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  captureUpdateProcesses,
  formatUpdateTimeoutDiagnostics,
} from "./update-timeout-observation.mjs";

const sampleIntervalMs = 5_000;
const sampleLimit = 7;
const signals = ["SIGTERM", "SIGINT", "SIGHUP"];

async function observeUpdateCommand(command, diagnosticsPath) {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  const samples = [];
  const sampling = new AbortController();
  let reported = false;
  const interrupted = () => {
    if (!reported) {
      reported = true;
      const report = formatUpdateTimeoutDiagnostics(samples);
      if (diagnosticsPath) {
        try {
          writeFileSync(diagnosticsPath, report, { flag: "wx", mode: 0o600 });
        } catch {
          // Existing evidence or an unavailable artifact must not change child settlement.
        }
      }
      process.stderr.write(report);
    }
  };
  // The existing timeout owns this process group and its kill-after deadline.
  // Do not relay its signal twice or exit before the real updater settles.
  for (const signal of signals) {
    process.on(signal, interrupted);
  }
  const result = new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({
        code: error.code === "ENOENT" ? 127 : error.code === "EACCES" ? 126 : 1,
        signal: null,
      }),
    );
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void (async () => {
    while (!sampling.signal.aborted && child.pid) {
      try {
        const sample = await captureUpdateProcesses(child.pid);
        if (sample.processes.length) {
          samples.push(sample);
          if (samples.length > sampleLimit) {
            samples.shift();
          }
        }
      } catch {
        // Observation failure must not change the timed command's outcome.
      }
      try {
        await delay(sampleIntervalMs, undefined, { signal: sampling.signal });
      } catch {
        break;
      }
    }
  })();
  try {
    return await result;
  } finally {
    sampling.abort();
    for (const signal of signals) {
      process.off(signal, interrupted);
    }
  }
}

if (import.meta.main) {
  const command = process.argv.slice(2);
  let diagnosticsPath;
  if (command[0] === "--diagnostics-path") {
    command.shift();
    diagnosticsPath = command.shift();
  }
  if (
    (diagnosticsPath !== undefined && !path.isAbsolute(diagnosticsPath)) ||
    command.shift() !== "--" ||
    !command.length
  ) {
    process.stderr.write(
      "Usage: update-timeout-diagnostics.mjs [--diagnostics-path absolute-file] -- command [args...]\n",
    );
    process.exitCode = 2;
  } else {
    const result = await observeUpdateCommand(command, diagnosticsPath);
    if (result.signal) {
      process.kill(process.pid, result.signal);
    } else {
      // A stuck /proc read must never keep the observer alive after the updater.
      process.exit(result.code ?? 1);
    }
  }
}
