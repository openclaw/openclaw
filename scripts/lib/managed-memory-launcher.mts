import { spawn } from "node:child_process";
import { signalExitCode } from "./managed-child-process.mts";
import { hasLinuxMemoryContainment } from "./process-memory.mts";

const [rawLimit, scope, shell, bin, ...args] = process.argv.slice(2);
const maxBytes = Number(rawLimit);
if (
  !scope ||
  !bin ||
  (shell !== "true" && shell !== "false") ||
  !Number.isSafeInteger(maxBytes) ||
  maxBytes <= 0 ||
  !hasLinuxMemoryContainment(maxBytes, {}, scope)
) {
  console.error(
    "[memory] The owned cgroup has no verified memory/swap limit; semantic command was not started. Use a cgroup-v2 host with a user systemd manager or a bounded Crabbox.",
  );
  process.exitCode = 75;
} else {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: process.env.OPENCLAW_MANAGED_NODE_OPTIONS ?? "",
  };
  delete env.OPENCLAW_MANAGED_NODE_OPTIONS;
  // The outer cgroup owner owns descendants and resource receipts, including OOM.
  // Keep both processes in the outer group: it owns signal delivery and grace.
  const child = spawn(bin, args, { env, stdio: "inherit", shell: shell === "true" });
  let received: NodeJS.Signals | undefined;
  let exitSignal: NodeJS.Signals | undefined;
  const remember = (signal: NodeJS.Signals) => {
    received ??= signal;
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
    (signal) => [signal, () => remember(signal)] as const,
  );
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  process.exitCode = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      console.error(error);
      resolve(75);
    });
    child.once("exit", (status, signal) => {
      exitSignal = received ?? signal ?? undefined;
      resolve(exitSignal ? signalExitCode(exitSignal) : (status ?? 75));
    });
  });
  for (const [signal, handler] of handlers) {
    process.off(signal, handler);
  }
  // The outer owner distinguishes a signal from numeric 143 to let surviving
  // descendants drain gracefully. Removing a signal listener restores its default
  // disposition in libuv, including Node's special SIGPIPE/SIGUSR1 dispositions.
  if (exitSignal) {
    if (exitSignal !== "SIGKILL" && exitSignal !== "SIGSTOP") {
      const reset = () => {};
      process.on(exitSignal, reset);
      process.off(exitSignal, reset);
    }
    process.kill(process.pid, exitSignal);
  }
}
