import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

type DiscordProviderSessionRuntimeModule = Pick<
  typeof import("./provider-session.runtime.js"),
  "getAcpSessionManager" | "isAcpRuntimeError" | "rethrowIncognitoSessionError"
>;

const DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS = 8_000;
const DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS = 2 * 60 * 1000;

export async function probeDiscordAcpBindingHealth(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  storedState?: "idle" | "running" | "error";
  lastActivityAt?: number;
  providerSessionRuntime: DiscordProviderSessionRuntimeModule;
}): Promise<{ status: "healthy" | "stale" | "uncertain"; reason?: string }> {
  const { getAcpSessionManager, isAcpRuntimeError } = params.providerSessionRuntime;
  const manager = getAcpSessionManager();
  const statusProbeAbortController = new AbortController();
  const statusPromise = manager
    .getSessionStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      signal: statusProbeAbortController.signal,
    })
    .then((status) => ({ kind: "status" as const, status }))
    .catch((error: unknown) => ({ kind: "error" as const, error }));

  const result = await raceWithTimeout(
    statusPromise,
    DISCORD_ACP_STATUS_PROBE_TIMEOUT_MS,
    () => ({ kind: "timeout" as const }),
    { ref: false },
  );
  if (result.kind === "timeout") {
    statusProbeAbortController.abort();
  }
  let runningForMs = 0;
  if (params.storedState === "running") {
    const activityAtMs = asDateTimestampMs(params.lastActivityAt);
    const boundedActivityAtMs =
      activityAtMs === undefined ? 0 : Math.max(0, Math.floor(activityAtMs));
    runningForMs = Math.max(0, Date.now() - boundedActivityAtMs);
  }
  const isStaleRunning =
    params.storedState === "running" && runningForMs >= DISCORD_ACP_STALE_RUNNING_ACTIVITY_MS;

  if (result.kind === "timeout") {
    return isStaleRunning
      ? { status: "stale", reason: "status-timeout-running-stale" }
      : { status: "uncertain", reason: "status-timeout" };
  }
  if (result.kind === "error") {
    params.providerSessionRuntime.rethrowIncognitoSessionError(result.error);
    const error = result.error;
    if (
      isAcpRuntimeError(error) &&
      ["SESSION_OWNER_MIGRATION_REQUIRED", "SESSION_OWNER_UNSUPPORTED"].includes(
        error.detailCode ?? "",
      )
    ) {
      return { status: "uncertain", reason: formatErrorMessage(error) };
    }
    if (isAcpRuntimeError(error) && error.code === "ACP_SESSION_INIT_FAILED") {
      return { status: "stale", reason: "session-init-failed" };
    }
    const message = formatErrorMessage(error);
    if (
      message.includes("Session is not ACP-enabled") ||
      message.includes("ACP session metadata missing")
    ) {
      return { status: "stale", reason: "session-missing" };
    }
    return isStaleRunning
      ? { status: "stale", reason: "status-error-running-stale" }
      : { status: "uncertain", reason: "status-error" };
  }
  if (result.status.state === "error") {
    return { status: "uncertain", reason: "status-error-state" };
  }
  return { status: "healthy" };
}
