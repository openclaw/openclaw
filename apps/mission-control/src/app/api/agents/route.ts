import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";
import { createAgentSchema, parseOrThrow } from "@/lib/schemas";

// POST - Create a new agent
// The current gateway version only supports a single "main" agent.
// Multi-agent creation requires a newer gateway or manual config editing.
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    parseOrThrow(createAgentSchema, await request.json());

    return NextResponse.json(
      {
        error: "Agent creation is not supported by the current gateway. The gateway only supports the default \"main\" agent. To add agents, edit the gateway config file and restart.",
      },
      { status: 501 }
    );
  } catch (error) {
    return handleApiError(error, "Failed to create agent");
  }
}, ApiGuardPresets.write);

// GET - List all agents
export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();
    const agents = await client.listAgents();
    return NextResponse.json({ agents });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        agents: [],
        degraded: true,
        connected: false,
        warning:
          "OpenClaw gateway is unavailable. Showing cached UI state until connection returns.",
      });
    }
    return handleApiError(error, "Failed to connect to OpenClaw Gateway");
  }
}, ApiGuardPresets.read);
