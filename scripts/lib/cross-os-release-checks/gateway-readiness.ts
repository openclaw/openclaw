import { appendFileSync } from "node:fs";
import type { CommandResult, GatewayHandle, LaneCommandParams } from "./config.ts";
import {
  CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
  gatewayReadyDeadlineMs,
} from "./config.ts";
import { hasChildExited, waitForGatewayWithStartupMigrationRestart } from "./process.ts";
import { formatError, sleep } from "./shared.ts";

type StatusCommand = (args: string[], timeoutMs: number) => Promise<CommandResult>;
export type GatewayReadinessParams = LaneCommandParams & {
  gateway?: GatewayHandle;
  gatewayHolder?: { current: GatewayHandle | null };
  gatewayLogPath?: string;
};

export async function resolveGatewayStatusArgs(
  run: StatusCommand,
  logPath: string,
  options: { requireRpc?: boolean } = {},
) {
  try {
    const help = await run(["gateway", "status", "--help"], 15_000);
    return buildGatewayStatusArgsFromHelpText(`${help.stdout}\n${help.stderr}`, options);
  } catch (error) {
    appendGatewayStatusHelpProbeFallback(logPath, error);
    return buildGatewayStatusArgsFromHelpText("--require-rpc", options);
  }
}

export async function waitForReleaseGateway(
  params: GatewayReadinessParams,
  run: StatusCommand,
  start: (logPath: string) => Promise<GatewayHandle>,
  retryStatusErrors = false,
): Promise<void> {
  if (params.gatewayHolder) {
    if (!params.gatewayLogPath) {
      throw new Error("Gateway restart coordination requires a gateway log path.");
    }
    const gatewayLogPath = params.gatewayLogPath;
    await waitForGatewayWithStartupMigrationRestart({
      gatewayHolder: params.gatewayHolder,
      restartGateway: () => start(gatewayLogPath),
      waitUntilReady: (gateway) =>
        waitForReleaseGateway(
          { ...params, gatewayHolder: undefined, gateway },
          run,
          start,
          retryStatusErrors,
        ),
    });
    return;
  }

  const statusArgs = await resolveGatewayStatusArgs(run, params.logPath);
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    if (params.gateway && hasChildExited(params.gateway.child)) {
      throw new Error(`Gateway exited before becoming ready on port ${params.lane.gatewayPort}.`);
    }
    let result;
    try {
      result = await run(statusArgs, CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS);
    } catch (error) {
      if (!retryStatusErrors) {
        throw error;
      }
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

export function buildGatewayStatusArgsFromHelpText(
  helpText: string,
  options: { requireRpc?: boolean } = {},
) {
  const requireRpc = options.requireRpc !== false;
  if (requireRpc && helpText.includes("--require-rpc")) {
    return [
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ];
  }
  return ["gateway", "status"];
}

function appendGatewayStatusHelpProbeFallback(logPath: string, error: unknown) {
  appendFileSync(
    logPath,
    `${new Date().toISOString()} gateway status help probe failed; assuming current --require-rpc support: ${formatError(error)}\n`,
  );
}
