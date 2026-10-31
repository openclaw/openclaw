import { fileURLToPath } from "node:url";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { run, warn } from "./host-command.ts";
import type { CommandResult, RunOptions } from "./types.ts";

export function resolveMacosPrlctlInvocation(
  command: string,
  args: string[],
  timeoutMs?: number,
  windows = false,
): { command: string; args: string[] } {
  if (
    command !== "prlctl" ||
    args[0] !== "exec" ||
    process.platform !== "darwin" ||
    process.arch !== "arm64"
  ) {
    return { command, args };
  }
  // Select before execution: an SDK failure must never replay a guest command.
  // The client verifies the installed binary; other versions retain prlctl.
  const timeoutArgs =
    timeoutMs === undefined ? [] : ["--timeout-ms", String(clampTimerTimeoutMs(timeoutMs) ?? 1)];
  return {
    command: "python3",
    args: [
      "-B",
      fileURLToPath(new URL("./parallels-exec.py", import.meta.url)),
      ...timeoutArgs,
      ...(windows ? ["--windows"] : []),
      "--",
      ...args,
    ],
  };
}

export function runMacosHostCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): CommandResult {
  const invocation = resolveMacosPrlctlInvocation(command, args, options.timeoutMs);
  return run(invocation.command, invocation.args, options);
}

export function runWindowsHostCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): CommandResult {
  const budgetMs = options.timeoutMs ?? 0;
  const deadline = Date.now() + budgetMs;
  const invocation = resolveMacosPrlctlInvocation(command, args, options.timeoutMs, true);
  let result = run(invocation.command, invocation.args, options);
  const programIndex = args[2] === "--current-user" ? 3 : 2;
  const canRetryStartup =
    command === "prlctl" &&
    invocation.command === "python3" &&
    args[0] === "exec" &&
    args[programIndex] === "powershell.exe" &&
    args.includes("-EncodedCommand") &&
    options.check === false &&
    Number.isFinite(budgetMs) &&
    budgetMs > 0;
  if (!canRetryStartup) {
    return result;
  }
  // Windows can fail PowerShell DLL initialization after cmd reports ready.
  // Retry only initialization failure, with fresh stdin and one budget.
  for (
    let attempt = 1;
    attempt < 5 &&
    result.status === 255 &&
    /^\[parallels-exec\] Windows guest exit code 0xc0000142\r?$/mu.test(result.stderr);
    attempt++
  ) {
    if (deadline - Date.now() <= 3000) {
      break;
    }
    warn(`Windows PowerShell DLL initialization failed; startup retry ${attempt}/4`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) {
      break;
    }
    const retry = resolveMacosPrlctlInvocation(command, args, timeoutMs, true);
    result = run(retry.command, retry.args, { ...options, timeoutMs });
  }
  return result;
}
