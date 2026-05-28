import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const overrideSmokeScriptPath = path.join(scriptDir, "dmad-run-test-timeout-smoke-override.mjs");

export function resolveOverrideQuickCheckEnv(
  sourceEnv = process.env,
  opts = { now: new Date(), pid: process.pid, tmpDir: os.tmpdir() },
) {
  const env = { ...sourceEnv };
  if (!env.DMAD_RUN_TEST_REPORT_PATH || env.DMAD_RUN_TEST_REPORT_PATH.trim() === "") {
    const stamp = opts.now.toISOString().replaceAll(":", "").replaceAll(".", "");
    env.DMAD_RUN_TEST_REPORT_PATH = path.join(
      opts.tmpDir,
      `custom-timeout-smoke-report-${stamp}-${opts.pid}.json`,
    );
  }
  return env;
}

export function summarizeOverrideQuickCheckReport(report) {
  return {
    runStatus: report.runStatus,
    qualityStatus: report.qualityStatus,
    totalTimeoutMs: report.totalTimeoutMs,
    runConfig_totalTimeoutMs: report.runConfig?.totalTimeoutMs,
  };
}

export async function runOverrideQuickCheck() {
  const env = resolveOverrideQuickCheckEnv(process.env);
  console.error(
    `[dmad-run-test-timeout-smoke-override-quick-check] report path: ${env.DMAD_RUN_TEST_REPORT_PATH}`,
  );

  const command = process.execPath;
  const args = [overrideSmokeScriptPath];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`override-smoke terminated by signal: ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 3) {
    console.error(
      `[dmad-run-test-timeout-smoke-override-quick-check] unexpected exit code: ${exitCode}`,
    );
    process.exit(exitCode || 1);
  }

  if (!fs.existsSync(env.DMAD_RUN_TEST_REPORT_PATH)) {
    console.error(
      `[dmad-run-test-timeout-smoke-override-quick-check] report not found: ${env.DMAD_RUN_TEST_REPORT_PATH}`,
    );
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(env.DMAD_RUN_TEST_REPORT_PATH, "utf8"));
  const summary = summarizeOverrideQuickCheckReport(report);
  console.error(
    `[dmad-run-test-timeout-smoke-override-quick-check] summary: ${JSON.stringify(summary)}`,
  );

  if (summary.runStatus !== "timeout" || summary.qualityStatus !== "degraded_agents") {
    console.error(
      "[dmad-run-test-timeout-smoke-override-quick-check] unexpected report status fields",
    );
    process.exit(1);
  }
  process.exit(0);
}

const isDirectRun = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
);

if (isDirectRun) {
  runOverrideQuickCheck().catch((error) => {
    console.error("[dmad-run-test-timeout-smoke-override-quick-check] failed:", error);
    process.exit(1);
  });
}
