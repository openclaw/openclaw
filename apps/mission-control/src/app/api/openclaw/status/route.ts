import { NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { isGatewayUnavailableError } from "@/lib/errors";

export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();

    const [health, agents, cronJobs] = await Promise.allSettled([
      client.health(),
      client.listAgents(),
      client.listCronJobs(),
    ]);

    return NextResponse.json({
      connected: client.isConnected(),
      health: health.status === "fulfilled" ? health.value : null,
      agentCount:
        agents.status === "fulfilled"
          ? (agents.value as unknown[]).length
          : 0,
      cronJobCount:
        cronJobs.status === "fulfilled"
          ? (cronJobs.value as unknown[]).length
          : 0,
      connectionMetrics: client.getConnectionMetrics(),
    });
  } catch (error) {
    const unavailable = isGatewayUnavailableError(error);
    return NextResponse.json({
      connected: false,
      degraded: true,
      warning: unavailable
        ? "Gateway is currently unavailable."
        : "Failed to determine gateway health.",
      agentCount: 0,
      cronJobCount: 0,
    });
  }
}, ApiGuardPresets.read);
