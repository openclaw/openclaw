import { NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";

export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();

    const [config, schema] = await Promise.allSettled([
      client.configGet(),
      client.configSchema(),
    ]);

    return NextResponse.json({
      config: config.status === "fulfilled" ? config.value : null,
      schema: schema.status === "fulfilled" ? schema.value : null,
    });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        config: null,
        schema: null,
        degraded: true,
        warning: "Gateway unavailable. Configuration data is temporarily unavailable.",
      });
    }
    return handleApiError(error, "Failed to fetch gateway config");
  }
}, ApiGuardPresets.read);
