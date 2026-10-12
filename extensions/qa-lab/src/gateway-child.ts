import { spawn } from "node:child_process";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle, type QaGatewayStopOptions } from "./gateway-child-lifecycle.js";
import {
  createQaGatewayChildLogAccess,
  formatQaGatewayProcessBoundaryStartupFailure,
  monitorQaGatewayChildFailure,
  throwQaGatewayChildFailure,
  type QaChildFailure,
} from "./gateway-child-process.js";
import {
  needsQaGatewayMigrationRestart,
  waitForGatewayListening,
  waitForGatewayReady,
  waitForQaGatewayRestartBoundary,
} from "./gateway-child-readiness.js";
import {
  prepareQaGatewayChild,
  type QaGatewayChildParams,
  type QaGatewayChildStateMutationContext,
} from "./gateway-child-setup.js";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { readProcessTreeCpuMs, readProcessTreeRssBytes } from "./process-tree-cpu.js";

export type { QaGatewayChildCommand } from "./gateway-child-command.js";
export type { QaGatewayStopResult, QaGatewayStopOptions } from "./gateway-child-lifecycle.js";
export type { QaGatewayChildListeningContext } from "./gateway-child-setup.js";
export type { QaCliBackendAuthMode } from "./providers/env.js";
export type QaGatewayChild = Awaited<ReturnType<typeof startOwnedGatewayChild>>;

export function createQaGatewayChild() {
  const lifetime = new QaGatewayChildLifecycle();
  let started = false;
  return {
    start(params: QaGatewayChildParams) {
      if (started) {
        throw new Error("qa gateway child startup already requested");
      }
      started = true;
      lifetime.repoRoot = params.repoRoot;
      return lifetime.run(() => startOwnedGatewayChild(params, lifetime));
    },
    stop: (opts?: QaGatewayStopOptions) => lifetime.stop(opts),
  };
}

async function startOwnedGatewayChild(
  params: QaGatewayChildParams,
  lifetime: QaGatewayChildLifecycle,
) {
  const setup = await prepareQaGatewayChild(params, lifetime);
  const {
    output,
    logs,
    stdoutLog,
    stderrLog,
    nodeExecPath,
    gatewayCwd,
    cliArgsPrefix,
    workspaceDir,
    stateDir,
    tempRoot,
    configPath,
    gatewayToken,
  } = setup;
  let active!: ReturnType<QaGatewayChildLifecycle["register"]>;
  let getChildFailure: (() => QaChildFailure | null) | undefined;
  const requireRpcClient = () => {
    if (!lifetime.rpcClient) {
      throw new Error("qa gateway rpc client is not ready");
    }
    return lifetime.rpcClient;
  };
  const throwActiveChildFailure = () => {
    lifetime.assertOpen();
    throwQaGatewayChildFailure(getChildFailure, logs);
  };
  const stopAttempt = async (startupError?: unknown) => {
    const result = await lifetime.stopProcess();
    const errors = [...result.errors];
    try {
      await lifetime.rpcClient?.stop();
    } catch (error) {
      errors.push(error);
    }
    lifetime.rpcClient = null;
    if (errors.length) {
      throw new AggregateError(
        startupError === undefined ? errors : [startupError, ...errors],
        "qa gateway attempt cleanup failed",
        { cause: startupError },
      );
    }
  };
  const launchReady = async (initial: boolean, attempt = 1) => {
    lifetime.assertOpen();
    const gatewayArgs = setup.buildGatewayArgs();
    const prepared = lifetime.controller
      ? await lifetime.controller.prepare({ args: gatewayArgs, cwd: gatewayCwd, env: launch.env })
      : null;
    lifetime.assertOpen();
    const child = spawn(nodeExecPath, gatewayArgs, {
      cwd: gatewayCwd,
      env: prepared?.env ?? launch.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Register synchronously: acceptance/readiness may reject with descendants
    // still alive, and replacement must immediately supersede its stopped parent.
    const owned = (active = lifetime.register(child, prepared));
    for (const [stream, label, log] of [
      [child.stdout, "stdout", stdoutLog],
      [child.stderr, "stderr", stderrLog],
    ] as const) {
      stream.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        output.push(label, buffer);
        log.write(buffer);
      });
    }
    getChildFailure = monitorQaGatewayChildFailure(
      child,
      output,
      () => owned.ready && !lifetime.signal.aborted && owned.settlement === undefined,
    );
    active.checkFailure = () => throwQaGatewayChildFailure(getChildFailure, logs);
    try {
      if (prepared && lifetime.controller) {
        active.identity = await lifetime.controller.accept({ child, prepared });
        lifetime.assertOpen();
        await lifetime.controller.signal(active.identity, "SIGCONT");
      }
    } catch (error) {
      throw new Error(formatQaGatewayProcessBoundaryStartupFailure(error, logs()), {
        cause: error,
      });
    }
    lifetime.assertOpen();
    const health = { baseUrl: launch.baseUrl, logs, child, getChildFailure, timeoutMs: 120_000 };
    if (initial) {
      await waitForGatewayListening(health);
      lifetime.assertOpen();
      await params.onListening?.({
        attempt,
        baseUrl: launch.baseUrl,
        wsUrl: launch.wsUrl,
        token: gatewayToken,
        configPath,
        runtimeEnv: launch.env,
      });
    }
    if (!initial || !params.allowUnhealthyStartup) {
      await waitForGatewayReady(health);
    }
    lifetime.assertOpen();
    lifetime.rpcClient = await startQaGatewayRpcClient({
      wsUrl: launch.wsUrl,
      token: gatewayToken,
      logs,
    });
    await lifetime.rpcClient.request("config.get", {}, { timeoutMs: 30_000 });
    throwActiveChildFailure();
    if (active.identity && lifetime.controller) {
      await lifetime.controller.markReady(active.identity);
    }
    lifetime.assertOpen();
    active.ready = true;
  };
  const launch = await setup.prepareAttempt();
  const attemptLogMark = output.mark();
  try {
    await launchReady(true);
  } catch (error) {
    const attemptLogs = output.readRedactedSince(attemptLogMark);
    if (
      !needsQaGatewayMigrationRestart(attemptLogs.trim() ? attemptLogs : formatErrorMessage(error))
    ) {
      throw error;
    }
    await stopAttempt(error);
    const retryBuffer = Buffer.from(
      `[qa-lab] gateway child startup attempt 1/2 completed plugin migration convergence; restarting once with the same state, config, and port ${launch.gatewayPort}\n`,
    );
    output.push("internal", retryBuffer);
    stdoutLog.write(retryBuffer);
    await launchReady(true, 2);
  }
  const { cfg, baseUrl, wsUrl, env: runningEnv } = launch;
  const signalActiveProcess = async (signal: NodeJS.Signals) => {
    if (active.identity && lifetime.controller) {
      if (signal !== "SIGUSR2" && signal !== "SIGQUIT") {
        throw new Error(`unsupported verified gateway signal: ${signal}`);
      }
      await lifetime.controller.signal(active.identity, signal);
      return;
    }
    if (!active.child.pid) {
      throw new Error("qa gateway child has no pid");
    }
    process.kill(active.child.pid, signal);
  };

  return {
    cfg,
    baseUrl,
    wsUrl,
    get evidenceIdentity() {
      return lifetime.rpcClient?.evidenceIdentity ?? null;
    },
    get pid() {
      return active.identity?.pid ?? active.child.pid ?? null;
    },
    getProcessCpuMs: () => readProcessTreeCpuMs(active.identity?.pid ?? active.child.pid ?? null),
    getProcessRssBytes: () =>
      readProcessTreeRssBytes(active.identity?.pid ?? active.child.pid ?? null),
    token: gatewayToken,
    workspaceDir,
    tempRoot,
    configPath,
    runtimeEnv: runningEnv,
    // Keep companion CLI calls inside the same packaged/runtime wrapper as the Gateway.
    // Process-boundary launchers also own the isolated runtime UID and state permissions.
    cliCommand: params.command
      ? { executablePath: nodeExecPath, argsPrefix: [...cliArgsPrefix], cwd: gatewayCwd }
      : undefined,
    logs,
    ...createQaGatewayChildLogAccess(output),
    runCli(args: readonly string[]) {
      throwActiveChildFailure();
      return runQaGatewayCliCommand({
        lifetime,
        executablePath: nodeExecPath,
        argsPrefix: cliArgsPrefix,
        args,
        cwd: gatewayCwd,
        env: runningEnv,
      });
    },
    async signalProcess(signal: NodeJS.Signals) {
      throwActiveChildFailure();
      await signalActiveProcess(signal);
    },
    async restart(signal: NodeJS.Signals = "SIGUSR2") {
      throwActiveChildFailure();
      const restartLogMark = output.mark();
      await signalActiveProcess(signal);
      if (signal === "SIGUSR2") {
        await waitForQaGatewayRestartBoundary({
          readLogsSince: (mark) => output.readSince(mark),
          mark: restartLogMark,
        });
        await waitForGatewayReady({
          baseUrl,
          logs,
          child: active.child,
          getChildFailure,
          timeoutMs: 120_000,
        });
      }
    },
    restartAfterStateMutation(
      mutateState: (context: QaGatewayChildStateMutationContext) => Promise<void>,
    ) {
      return lifetime.run(async () => {
        await stopAttempt();
        await mutateState({ configPath, runtimeEnv: runningEnv, stateDir, tempRoot });
        // Mutation can reopen parent stores; release them before child startup maintenance.
        await closeQaRuntimeStores(tempRoot);
        const replacementLogMark = output.mark();
        try {
          await launchReady(false);
        } catch (error) {
          if (
            !needsQaGatewayMigrationRestart(
              [output.readRedactedSince(replacementLogMark), formatErrorMessage(error)].join("\n"),
            )
          ) {
            throw error;
          }
          await stopAttempt(error);
          const retryBuffer = Buffer.from(
            "[qa-lab] replacement gateway completed plugin migration convergence; restarting once with the same state, config, and port\n",
          );
          output.push("internal", retryBuffer);
          stdoutLog.write(retryBuffer);
          await launchReady(false);
        }
      });
    },
    async call(
      method: string,
      rpcParams?: unknown,
      opts?: { deadlineMs?: number; expectFinal?: boolean; timeoutMs?: number },
    ) {
      throwActiveChildFailure();
      try {
        // The RPC client owns unsent reconnects; replaying a sent call can repeat committed work.
        return await requireRpcClient().request(method, rpcParams, opts);
      } catch (error) {
        throwActiveChildFailure();
        throw error;
      }
    },
    async stop(opts?: QaGatewayStopOptions) {
      const result = await lifetime.stop(opts);
      if (result.errors.length) {
        throw new AggregateError(
          result.errors,
          `qa gateway child cleanup failed: ${result.errors.map(formatErrorMessage).join("; ")}`,
        );
      }
    },
  };
}
