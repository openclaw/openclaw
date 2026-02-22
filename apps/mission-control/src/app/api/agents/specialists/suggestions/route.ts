import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { parseOrThrow, specialistSuggestionQuerySchema } from "@/lib/schemas";
import { buildSpecialistSuggestionBundle } from "@/lib/specialist-suggestions";

// GET /api/agents/specialists/suggestions
export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(specialistSuggestionQuerySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
    });
    const suggestions = buildSpecialistSuggestionBundle({
      workspaceId: query.workspace_id,
    });

    return NextResponse.json({
      workspaceId: query.workspace_id ?? null,
      suggestions,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error, "Failed to build specialist suggestions");
  }
}, ApiGuardPresets.read);

