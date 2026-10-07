import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { QaSuiteInfraError } from "./errors.js";
import {
  hasQaGatewayChildExited,
  type QaChildFailure,
  throwQaGatewayChildFailure,
} from "./gateway-child-process.js";

export const QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS = 5;
const QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS = 90_000;
const QA_GATEWAY_MIGRATION_CONVERGENCE_RESTART_PREFIX =
  "OpenClaw plugin migration inputs changed during startup convergence;";

type QaGatewayStartupRetryKind = "bind-collision" | "migration-convergence-restart";

type QaGatewayHealthChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function classifyQaGatewayStartupRetry(details: string): QaGatewayStartupRetryKind | null {
  if (details.includes(QA_GATEWAY_MIGRATION_CONVERGENCE_RESTART_PREFIX)) {
    return "migration-convergence-restart";
  }
  if (
    details.includes("another gateway instance is already listening on ws://") ||
    details.includes("failed to bind gateway socket on ws://") ||
    details.includes("EADDRINUSE") ||
    details.includes("address already in use")
  ) {
    return "bind-collision";
  }
  return null;
}

export function resolveQaGatewayStartupRetry(params: {
  attempt: number;
  details: string;
  migrationConvergenceRestartUsed: boolean;
}) {
  if (params.attempt >= QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS) {
    return null;
  }
  const kind = classifyQaGatewayStartupRetry(params.details);
  if (
    !kind ||
    (kind === "migration-convergence-restart" && params.migrationConvergenceRestartUsed)
  ) {
    return null;
  }
  return {
    kind,
    reuseLaunchState: kind === "migration-convergence-restart",
    migrationConvergenceRestartUsed:
      params.migrationConvergenceRestartUsed || kind === "migration-convergence-restart",
  };
}

async function fetchLocalGatewayProbe(params: {
  baseUrl: string;
  kind: "health" | "listening";
  timeoutMs?: number;
}): Promise<boolean> {
  const signal = AbortSignal.timeout(params.timeoutMs ?? 2_000);
  // Readiness can be green while agent inspection is pending; both probes share one budget.
  const endpoints = params.kind === "health" ? ["startupz", "readyz"] : ["healthz"];
  for (const endpoint of endpoints) {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${params.baseUrl}/${endpoint}`,
      init: {
        method: "HEAD",
        headers: {
          connection: "close",
        },
        signal,
      },
      policy: { allowPrivateNetwork: true },
      auditContext: `qa-lab-gateway-child-${params.kind}`,
    });
    try {
      if (params.kind === "health" && !response.ok) {
        return false;
      }
    } finally {
      await release();
    }
  }
  return true;
}

export async function waitForQaGatewayRestartBoundary(params: {
  readLogsSince: (mark: number) => string;
  mark: number;
  pollMs?: number;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS;
  const pollMs = resolveTimerTimeoutMs(params.pollMs ?? 100, 100, 0);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (params.readLogsSince(params.mark).includes("restart mode:")) {
      return;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollMs, remainingMs));
  }
  throw new Error(`qa gateway child did not reach restart boundary within ${timeoutMs}ms`);
}

type QaGatewayProbeParams = {
  baseUrl: string;
  logs: () => string;
  child: QaGatewayHealthChild;
  getChildFailure?: () => QaChildFailure | null;
  timeoutMs?: number;
};

async function waitForGatewayProbe(params: QaGatewayProbeParams, kind: "health" | "listening") {
  const deadline = Date.now() + (params.timeoutMs ?? 60_000);
  const phase = kind === "health" ? "becoming healthy" : "listening";
  let remainingMs: number;
  while ((remainingMs = deadline - Date.now()) > 0) {
    throwQaGatewayChildFailure(params.getChildFailure, params.logs);
    if (hasQaGatewayChildExited(params.child)) {
      throw new QaSuiteInfraError(
        "gateway_startup_unhealthy",
        `gateway exited before ${phase} (exitCode=${String(params.child.exitCode)}, signal=${String(params.child.signalCode)}):\n${params.logs()}`,
      );
    }
    // Listener liveness can turn green before the Gateway can admit startup or restart work.
    try {
      if (
        await fetchLocalGatewayProbe({
          baseUrl: params.baseUrl,
          kind,
          timeoutMs: kind === "health" ? Math.min(2_000, remainingMs) : undefined,
        })
      ) {
        return;
      }
    } catch {}
    await sleep(kind === "health" ? Math.min(250, Math.max(0, deadline - Date.now())) : 100);
  }
  throw new QaSuiteInfraError(
    "gateway_startup_unhealthy",
    `gateway failed to ${kind === "health" ? "become healthy" : "listen before timeout"}:\n${params.logs()}`,
  );
}

export function waitForGatewayReady(params: QaGatewayProbeParams) {
  return waitForGatewayProbe(params, "health");
}

export function waitForGatewayListening(params: QaGatewayProbeParams) {
  return waitForGatewayProbe(params, "listening");
}

export function isRetryableRpcStartupError(error: unknown) {
  // Startup errors cross the same low-level client/log boundary; timeout and
  // token-mismatch retry facts exist only in the formatted diagnostic.
  const details = formatErrorMessage(error);
  return (
    details.includes("gateway timeout after") ||
    details.includes("handshake timeout") ||
    details.includes("gateway token mismatch") ||
    details.includes("token mismatch") ||
    details.includes("gateway closed (1000") ||
    details.includes("gateway closed (1006") ||
    details.includes("gateway closed (1012)")
  );
}
