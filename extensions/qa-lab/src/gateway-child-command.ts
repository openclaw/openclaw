// Qa Lab plugin module owns gateway child command bootstrap behavior.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  readQaChildOutput,
} from "./child-output.js";
import type { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { monitorQaChildFailure } from "./gateway-child-process.js";
import { createQaGatewayCliError } from "./gateway-log-redaction.js";
import type { QaGatewayProcessBoundaryConfig } from "./gateway-process-boundary.js";
import { createQaRepairProgressObserver } from "./gateway-repair-progress.js";

type QaGatewayChildDirectCommand = {
  executablePath: string;
  argsPrefix?: string[];
  argsSuffix?: string[];
  cwd?: string;
  tempParentDir?: string;
  usePackagedPlugins?: boolean;
  processBoundary?: undefined;
};

const QA_GATEWAY_CLI_EXECUTION_TIMEOUT_MS = 120_000;

type QaGatewayChildVerifiedCommand = Omit<QaGatewayChildDirectCommand, "processBoundary"> & {
  processBoundary: QaGatewayProcessBoundaryConfig;
};

export type QaGatewayChildCommand = QaGatewayChildDirectCommand | QaGatewayChildVerifiedCommand;

export function resolveQaGatewayChildCommand(repoRoot: string): QaGatewayChildCommand {
  for (const relativePath of ["scripts/run-node.mjs", "dist/index.mjs", "dist/index.js"]) {
    const entryPath = path.join(repoRoot, relativePath);
    if (existsSync(entryPath)) {
      return {
        executablePath: process.execPath,
        argsPrefix: [entryPath],
        cwd: repoRoot,
        usePackagedPlugins: true,
      };
    }
  }

  throw new Error(
    "OpenClaw CLI entry not found: expected scripts/run-node.mjs or dist/index.(m)js",
  );
}

export async function runQaGatewayCliCommand(params: {
  lifetime: QaGatewayChildLifecycle;
  executablePath: string;
  argsPrefix: readonly string[];
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}): Promise<string> {
  params.lifetime.assertOpen();
  const hasStdin = params.stdin !== undefined;
  const child = spawn(params.executablePath, [...params.argsPrefix, ...params.args], {
    cwd: params.cwd,
    env: { ...params.env, OPENCLAW_CLI: "1" },
    detached: process.platform !== "win32",
    stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  // Admission, spawn, and registration share one synchronous turn, before any
  // stdin or process events can race a stop request.
  const owned = params.lifetime.register(child, null, "cli");
  const repair =
    params.args[0] === "update" && params.args[1] === "repair" && !params.args.includes("--help");
  const result = readQaGatewayCliCommand(child, params.lifetime, owned, repair);
  params.lifetime.completeCli(owned, result);
  if (hasStdin) {
    child.stdin?.end(params.stdin);
  }
  return await result;
}

async function readQaGatewayCliCommand(
  child: ChildProcess,
  lifetime: QaGatewayChildLifecycle,
  owned: ReturnType<QaGatewayChildLifecycle["register"]>,
  repair: boolean,
): Promise<string> {
  const stdout = createQaChildOutputCapture();
  const stderr = createQaChildOutputTail();
  child.stdout?.on("data", (chunk) => appendQaChildOutput(stdout, chunk));

  let failure: Error | undefined;
  let finish!: (code: number | undefined) => void;
  const terminal = new Promise<number | undefined>((resolve) => {
    finish = resolve;
  });
  const fail = (error: unknown) => {
    failure ??= createQaGatewayCliError(error);
    finish(undefined);
  };
  monitorQaChildFailure(child, ({ source, error }) => {
    fail(`qa gateway cli ${source} failed: ${createQaGatewayCliError(error).message}`);
  });
  child.stdin?.once("error", (error) =>
    fail(`qa gateway cli stdin failed: ${createQaGatewayCliError(error).message}`),
  );
  child.once("exit", (code) => finish(code ?? 1));
  const onAbort = () => fail("qa gateway CLI cancelled: lifecycle is closed");
  lifetime.signal.addEventListener("abort", onAbort, { once: true });
  // Repair has serial phases, each with its own runtime budget. Do not spend the
  // cache/settlement allowance while Doctor is still making forward progress.
  const executionTimer = setTimeout(
    () =>
      fail(
        repair
          ? `qa gateway CLI made no update repair phase progress for ${QA_GATEWAY_CLI_EXECUTION_TIMEOUT_MS}ms`
          : `qa gateway CLI exceeded ${QA_GATEWAY_CLI_EXECUTION_TIMEOUT_MS}ms`,
      ),
    QA_GATEWAY_CLI_EXECUTION_TIMEOUT_MS,
  );
  let observingProgress = true;
  const observeProgress = repair
    ? createQaRepairProgressObserver(() => {
        if (observingProgress) {
          executionTimer.refresh();
        }
      })
    : undefined;
  child.stderr?.on("data", (chunk) => {
    appendQaChildOutputTail(stderr, chunk);
    observeProgress?.(chunk);
  });
  let exitCode: number | undefined;
  let stopped: Awaited<ReturnType<QaGatewayChildLifecycle["stopProcess"]>>;
  try {
    exitCode = await terminal;
    observingProgress = false;
    clearTimeout(executionTimer);
    // Leader exit is not group settlement or pipe closure. Settle the owned tree
    // even after success/errors; never wait for close after unconfirmed shutdown.
    stopped = await lifetime.stopProcess(owned);
    if (stopped.process !== "unconfirmed") {
      try {
        await lifetime.waitForClose(owned);
      } catch (error) {
        fail(error);
      }
    }
  } finally {
    observingProgress = false;
    clearTimeout(executionTimer);
    lifetime.signal.removeEventListener("abort", onAbort);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const stdoutText = readQaChildOutput(stdout);
  if (failure || exitCode !== 0) {
    // Preserve the first failure's reason, but include output drained during shutdown.
    const reason = failure?.message ?? `OpenClaw CLI exited ${exitCode}`;
    const stderrText = formatQaChildOutputTail(stderr, "stderr");
    failure = createQaGatewayCliError(
      `${reason}: ${[stderrText, stdoutText].filter(Boolean).join("\n")}`,
    );
  }
  if (stopped.errors.length) {
    throw new AggregateError(
      failure ? [failure, ...stopped.errors] : stopped.errors,
      failure?.message ?? "qa gateway CLI cleanup failed",
      { cause: failure },
    );
  }
  if (failure) {
    throw failure;
  }
  lifetime.assertOpen();
  return stdoutText;
}
