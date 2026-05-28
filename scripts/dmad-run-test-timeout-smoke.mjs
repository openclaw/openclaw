import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveTimeoutSmokeEnv(
  sourceEnv = process.env,
  opts = { now: new Date(), pid: process.pid, tmpDir: os.tmpdir() },
) {
  const env = { ...sourceEnv };
  if (!env.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS || env.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS.trim() === "") {
    env.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS = "0";
  }
  if (!env.DMAD_RUN_TEST_REPORT_PATH || env.DMAD_RUN_TEST_REPORT_PATH.trim() === "") {
    const stamp = opts.now.toISOString().replaceAll(":", "").replaceAll(".", "");
    env.DMAD_RUN_TEST_REPORT_PATH = path.join(
      opts.tmpDir,
      `dmad-run-test-timeout-smoke-${stamp}-${opts.pid}.json`,
    );
  }
  return env;
}

export function resolveTimeoutSmokeReportPathSource(sourceEnv = process.env) {
  if (!sourceEnv.DMAD_RUN_TEST_REPORT_PATH || sourceEnv.DMAD_RUN_TEST_REPORT_PATH.trim() === "") {
    return "default_temp";
  }
  return "override";
}

export function resolveTimeoutSmokeCommand(platform = process.platform) {
  return platform === "win32"
    ? {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "pnpm dmad:run-test"],
      }
    : {
        command: "pnpm",
        args: ["dmad:run-test"],
      };
}

export function runTimeoutSmoke() {
  const reportPathSource = resolveTimeoutSmokeReportPathSource(process.env);
  const env = resolveTimeoutSmokeEnv();
  const command = resolveTimeoutSmokeCommand();

  console.error(`[dmad-run-test-timeout-smoke] report path: ${env.DMAD_RUN_TEST_REPORT_PATH}`);
  console.error(`[dmad-run-test-timeout-smoke] report path source: ${reportPathSource}`);

  const child = spawn(command.command, command.args, {
    env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error("[dmad-run-test-timeout-smoke] failed to spawn pnpm:", error);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[dmad-run-test-timeout-smoke] child terminated by signal: ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

const isDirectRun = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
);

if (isDirectRun) {
  runTimeoutSmoke();
}
