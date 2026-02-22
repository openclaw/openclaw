import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import {
  handleApiError,
  isGatewayUnavailableError,
  isGatewayUnsupportedMethodError,
} from "@/lib/errors";
import { chatSessionsSearchSchema, parseOrThrow } from "@/lib/schemas";

export const POST = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatSessionsSearchSchema, await req.json());
    const client = getOpenClawClient();
    await client.connect();

    const result = await client.searchSessions(payload);
    return NextResponse.json(result);
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        results: [],
        nextOffset: undefined,
        degraded: true,
        warning:
          "Gateway unavailable. Session search is temporarily unavailable.",
      });
    }
    if (isGatewayUnsupportedMethodError(error, "sessions.search")) {
      return NextResponse.json({
        results: [],
        nextOffset: undefined,
        degraded: true,
        warning: "Gateway version does not support sessions.search yet. Upgrade gateway.",
      });
    }
    return handleApiError(error, "Failed to search sessions");
  }
}, ApiGuardPresets.read);
