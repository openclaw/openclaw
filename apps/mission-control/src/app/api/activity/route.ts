import { NextRequest, NextResponse } from "next/server";
import { listActivity } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { activityListQuerySchema, parseOrThrow } from "@/lib/schemas";

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const query = parseOrThrow(activityListQuerySchema, {
      workspace_id: request.nextUrl.searchParams.get("workspace_id") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      type: request.nextUrl.searchParams.get("type") ?? undefined,
    });
    const activity = listActivity({
      workspace_id: query.workspace_id,
      limit: query.limit ?? 50,
      type: query.type,
    });
    return NextResponse.json({ activity });
  } catch (error) {
    return handleApiError(error, "Failed to fetch activity");
  }
}, ApiGuardPresets.read);
