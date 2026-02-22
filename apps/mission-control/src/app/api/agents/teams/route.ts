import { NextResponse } from "next/server";
import { getAgentTeams } from "@/lib/agent-registry";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";

export const GET = withApiGuard(async () => {
  try {
    const teams = getAgentTeams();
    return NextResponse.json(teams);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch agent teams" },
      { status: 500 }
    );
  }
}, ApiGuardPresets.read);
