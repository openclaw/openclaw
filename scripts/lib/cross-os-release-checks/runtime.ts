import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { runReleaseAgentTurn } from "./agent.ts";
import type {
  AgentTurnResult,
  GatewayHandle,
  LaneCommandParams,
  LaneState,
  ProviderConfig,
} from "./config.ts";
import {
  CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS,
  CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
  buildReleaseModelConfigCommands,
  gatewayReadyDeadlineMs,
  managedGatewayRestartCommandTimeoutMs,
} from "./config.ts";
import { installedEntryPath } from "./install.ts";
import {
  appendGatewayStatusHelpProbeFallback,
  buildGatewayStatusArgsFromHelpText,
  buildReleaseOnboardArgs,
  ensureManagedGatewayReady,
  resolveInstalledGatewayStopArgs,
  runInstalledCli,
} from "./installed.ts";
import { readLogFileSize } from "./logs.ts";
import {
  dashboardHtmlMarkerStatus,
  readBoundedCrossOsResponseText,
  resolveDashboardAssetUrls,
  verifyDashboardAssetUrls,
} from "./network-smokes.ts";
import {
  hasChildExited,
  registerActiveChildProcessTree,
  runCommand,
  waitForGatewayWithStartupMigrationRestart,
} from "./process.ts";
import { logLanePhase } from "./reporting.ts";
import { formatError, sleep } from "./shared.ts";

export async function runOpenClaw(params: {
  lane: LaneState;
  args: string[];
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs?: number;
  check?: boolean;
}) {
  return runCommand(process.execPath, [installedEntryPath(params.lane.prefixDir), ...params.args], {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    check: params.check ?? true,
  });
}

export async function runOnboard(params: LaneCommandParams & { providerConfig: ProviderConfig }) {
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: buildReleaseOnboardArgs({
      authChoice: params.providerConfig.authChoice,
      gatewayPort: params.lane.gatewayPort,
      skipHealth: true,
    }),
    logPath: params.logPath,
    timeoutMs: 10 * 60 * 1000,
  });
}

export async function exerciseManagedGatewayLifecycle(
  params: Pick<LaneCommandParams, "lane" | "env"> & { cliPath: string; logPrefix: string },
) {
  logLanePhase(params.lane, "gateway-ready");
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready.log`,
  });

  logLanePhase(params.lane, "gateway-restart");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "restart"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-restart.log`,
    timeoutMs: managedGatewayRestartCommandTimeoutMs(),
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready-after-restart.log`,
  });

  logLanePhase(params.lane, "gateway-stop");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: await resolveInstalledGatewayStopArgs({
      cliPath: params.cliPath,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: `${params.logPrefix}-stop-help.log`,
    }),
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-stop.log`,
    timeoutMs: 2 * 60 * 1000,
  });

  logLanePhase(params.lane, "gateway-start");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "start"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-start.log`,
    timeoutMs: 2 * 60 * 1000,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready-after-start.log`,
  });
}

export async function startGateway(params: LaneCommandParams): Promise<GatewayHandle> {
  const launchLogOffset = readLogFileSize(params.logPath);
  const gatewayLog = createWriteStream(params.logPath, { flags: "a" });
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(
    process.execPath,
    [
      installedEntryPath(params.lane.prefixDir),
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(params.lane.gatewayPort),
      "--force",
    ],
    {
      cwd: params.lane.homeDir,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
      windowsHide: true,
    },
  );
  const activeChildTree = registerActiveChildProcessTree(child);
  child.stdout?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  let resolveChildClose: () => void;
  const childClosePromise = new Promise<void>((resolvePromise) => {
    resolveChildClose = resolvePromise;
  });
  let closeLogPromise: Promise<void> | undefined;
  const closeLog = () => {
    closeLogPromise ??= new Promise<void>((resolvePromise) => {
      gatewayLog.once("error", () => resolvePromise());
      gatewayLog.end(() => resolvePromise());
    });
    return closeLogPromise;
  };
  child.once("close", () => {
    resolveChildClose();
    activeChildTree.unregister();
    void closeLog();
  });
  child.once("error", () => {
    resolveChildClose();
    activeChildTree.unregister();
    void closeLog();
  });
  return {
    child,
    closeLog,
    launchLogOffset,
    logPath: params.logPath,
    waitForClose: () => childClosePromise,
  };
}

export async function waitForGateway(
  params: LaneCommandParams & {
    gateway?: GatewayHandle;
    gatewayHolder?: { current: GatewayHandle | null };
    gatewayLogPath?: string;
  },
) {
  if (params.gatewayHolder) {
    if (!params.gatewayLogPath) {
      throw new Error("Gateway restart coordination requires a gateway log path.");
    }
    const gatewayLogPath = params.gatewayLogPath;
    await waitForGatewayWithStartupMigrationRestart({
      gatewayHolder: params.gatewayHolder,
      restartGateway: () =>
        startGateway({
          lane: params.lane,
          env: params.env,
          logPath: gatewayLogPath,
        }),
      waitUntilReady: (gateway) =>
        waitForGateway({
          lane: params.lane,
          env: params.env,
          gateway,
          logPath: params.logPath,
        }),
    });
    return;
  }

  const statusArgs = await resolveGatewayStatusArgs(params.lane, params.env, params.logPath);
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    if (params.gateway && hasChildExited(params.gateway.child)) {
      throw new Error(`Gateway exited before becoming ready on port ${params.lane.gatewayPort}.`);
    }
    let result;
    try {
      result = await runOpenClaw({
        lane: params.lane,
        env: params.env,
        args: statusArgs,
        logPath: params.logPath,
        timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
        check: false,
      });
    } catch {
      await sleep(2_000);
      continue;
    }
    if (result.exitCode === 0) {
      return;
    }
    if (params.gateway && hasChildExited(params.gateway.child)) {
      throw new Error(`Gateway exited before becoming ready on port ${params.lane.gatewayPort}.`);
    }
    await sleep(2_000);
  }
  throw new Error(`Gateway did not become ready on port ${params.lane.gatewayPort}.`);
}

async function resolveGatewayStatusArgs(lane: LaneState, env: NodeJS.ProcessEnv, logPath: string) {
  try {
    const help = await runOpenClaw({
      lane,
      env,
      args: ["gateway", "status", "--help"],
      logPath,
      timeoutMs: 15_000,
      check: false,
    });
    return buildGatewayStatusArgsFromHelpText(`${help.stdout}\n${help.stderr}`);
  } catch (error) {
    appendGatewayStatusHelpProbeFallback(logPath, error);
    return buildGatewayStatusArgsFromHelpText("--require-rpc");
  }
}

export async function runModelsSet(params: LaneCommandParams & { providerConfig: ProviderConfig }) {
  for (const args of buildReleaseModelConfigCommands(params.providerConfig)) {
    await runOpenClaw({
      lane: params.lane,
      env: params.env,
      args,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
  }
}

export async function runAgentTurn(
  params: LaneCommandParams & { label: string },
): Promise<AgentTurnResult> {
  return runReleaseAgentTurn(
    params,
    (args, timeoutMs) =>
      runOpenClaw({
        lane: params.lane,
        env: params.env,
        args,
        logPath: params.logPath,
        timeoutMs,
      }),
    "agent turn",
  );
}

export async function runDashboardSmoke(params: Pick<LaneCommandParams, "lane" | "logPath">) {
  const dashboardUrl = `http://127.0.0.1:${params.lane.gatewayPort}/`;
  const logStream = createWriteStream(params.logPath, { flags: "a" });
  const deadline = Date.now() + CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS;
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      attempt += 1;
      logStream.write(`${new Date().toISOString()} attempt=${attempt} url=${dashboardUrl}\n`);
      try {
        const signal = AbortSignal.timeout(CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS);
        const response = await fetch(dashboardUrl, {
          signal,
        });
        const html = await readBoundedCrossOsResponseText(response, undefined, { signal });
        const markers = dashboardHtmlMarkerStatus(html);
        const assetUrls = resolveDashboardAssetUrls(dashboardUrl, html);
        if (response.ok && markers.ready) {
          const assets = await verifyDashboardAssetUrls(assetUrls);
          if (assets.ok) {
            logStream.write(
              `${new Date().toISOString()} dashboard-ready status=${response.status} assets=${assetUrls.length}\n`,
            );
            return;
          }
          logStream.write(
            `${new Date().toISOString()} dashboard-assets-not-ready status=${response.status} assets=${assetUrls.length} failures=${assets.failures.join(" | ")}\n`,
          );
        }
        logStream.write(
          `${new Date().toISOString()} dashboard-not-ready status=${response.status} title=${markers.title} app=${markers.app} assets=${assetUrls.length}\n`,
        );
      } catch (error) {
        logStream.write(
          `${new Date().toISOString()} dashboard-fetch-error ${formatError(error)}\n`,
        );
      }
      await sleep(1_000);
    }
  } finally {
    logStream.end();
  }
  throw new Error(`Dashboard HTML did not become ready at ${dashboardUrl}.`);
}
