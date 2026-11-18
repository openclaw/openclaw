import { setTimeout as sleep } from "node:timers/promises";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteInfraError } from "./errors.js";
import {
  hasQaGatewayChildExited,
  type QaChildFailure,
  throwQaGatewayChildFailure,
} from "./gateway-child-process.js";

const QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS = 90_000;
const QA_GATEWAY_MIGRATION_CONVERGENCE_RESTART_PREFIX =
  "OpenClaw plugin migration inputs changed during startup convergence;";

type QaGatewayHealthChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

export function needsQaGatewayMigrationRestart(details: string) {
  return details.includes(QA_GATEWAY_MIGRATION_CONVERGENCE_RESTART_PREFIX);
}

async function fetchLocalGatewayProbe(params: {
  baseUrl: string;
  kind: "health" | "listening";
  timeoutMs?: number;
}): Promise<boolean> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.baseUrl}/${params.kind === "health" ? "readyz" : "healthz"}`,
    init: {
      method: params.kind === "health" ? "GET" : "HEAD",
      headers: {
        connection: "close",
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 2_000),
    },
    policy: { allowPrivateNetwork: true },
    auditContext: `qa-lab-gateway-child-${params.kind}`,
  });
  try {
    if (params.kind === "listening") {
      return true;
    }
    const readiness: unknown = await response.json();
    const refused =
      isRecord(readiness) && Array.isArray(readiness.agentDatabases)
        ? readiness.agentDatabases.filter(
            (entry) =>
              isRecord(entry) &&
              typeof entry.code === "string" &&
              entry.code !== "agent-database-inspection-pending",
          )
        : [];
    if (refused.length) {
      throw new QaSuiteInfraError(
        "gateway_startup_unhealthy",
        `gateway agent database admission refused: ${JSON.stringify(refused)}`,
      );
    }
    return (
      response.ok &&
      isRecord(readiness) &&
      readiness.ready === true &&
      (!Array.isArray(readiness.agentDatabases) || readiness.agentDatabases.length === 0)
    );
  } finally {
    await release();
  }
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
    } catch (error) {
      if (error instanceof QaSuiteInfraError) {
        throw error;
      }
    }
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
