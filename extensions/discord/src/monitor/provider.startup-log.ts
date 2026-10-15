import { isVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { GatewayPluginContract } from "../internal/plugin-contract.js";

function formatDiscordStartupGatewayState(gateway?: GatewayPluginContract): string {
  if (!gateway) {
    return "gateway=missing";
  }
  const reconnectAttempts = (gateway as unknown as { reconnectAttempts?: unknown })
    .reconnectAttempts;
  return `gatewayConnected=${gateway.isConnected ? "true" : "false"} reconnectAttempts=${typeof reconnectAttempts === "number" ? reconnectAttempts : "na"}`;
}

export function logDiscordStartupPhase(params: {
  runtime: RuntimeEnv;
  accountId: string;
  phase: string;
  startAt: number;
  gateway?: GatewayPluginContract;
  details?: string;
  isVerbose?: () => boolean;
}) {
  if (!(params.isVerbose ?? isVerbose)()) {
    return;
  }
  const elapsedMs = Math.max(0, Date.now() - params.startAt);
  const suffix = [params.details, formatDiscordStartupGatewayState(params.gateway)]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  params.runtime.log?.(
    `discord startup [${params.accountId}] ${params.phase} ${elapsedMs}ms${suffix ? ` ${suffix}` : ""}`,
  );
}
