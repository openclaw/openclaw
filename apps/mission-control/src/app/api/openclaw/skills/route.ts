import { NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";

export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();
    const data = await client.skillsStatus();
    return NextResponse.json(data);
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        skills: [],
        degraded: true,
        warning: "Gateway unavailable. Skills status will resume after reconnection.",
      });
    }
    return handleApiError(error, "Failed to fetch skills status");
  }
}, ApiGuardPresets.read);
