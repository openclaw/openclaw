import { NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { getCommunitySkillsCatalog } from "@/lib/community-catalog";

export const GET = withApiGuard(async () => {
  try {
    const catalog = getCommunitySkillsCatalog();
    return NextResponse.json({
      skills: catalog.skills,
      total: catalog.total,
      generatedAt: catalog.generatedAt,
      sourceZips: catalog.sourceZips || [],
    });
  } catch (error) {
    return handleApiError(error, "Failed to load community skills catalog");
  }
}, ApiGuardPresets.read);
