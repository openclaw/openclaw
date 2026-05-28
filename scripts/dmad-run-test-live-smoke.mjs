import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LIVE_SMOKE_DEFAULTS = {
  DMAD_RUN_TEST_MAX_ROUNDS: "1",
  DMAD_RUN_TEST_MOA_TIMEOUT_MS: "60000",
  DMAD_RUN_TEST_TOTAL_TIMEOUT_MS: "360000",
  DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS: "20000",
};

export function resolveLiveSmokeEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const [key, value] of Object.entries(LIVE_SMOKE_DEFAULTS)) {
    if (!env[key] || env[key].trim() === "") {
      env[key] = value;
    }
  }
  return env;
}

export function resolveLiveSmokeCommand(platform = process.platform) {
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

export function runLiveSmoke() {
  const env = resolveLiveSmokeEnv();
  const command = resolveLiveSmokeCommand();

  console.error(
    `[dmad-run-test-live-smoke] maxRounds=${env.DMAD_RUN_TEST_MAX_ROUNDS} moaTimeoutMs=${env.DMAD_RUN_TEST_MOA_TIMEOUT_MS} totalTimeoutMs=${env.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS} verificationTimeoutMs=${env.DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS}`,
  );

  const child = spawn(command.command, command.args, {
    env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error("[dmad-run-test-live-smoke] failed to spawn pnpm:", error);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[dmad-run-test-live-smoke] child terminated by signal: ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

const isDirectRun = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
);

if (isDirectRun) {
  runLiveSmoke();
}
