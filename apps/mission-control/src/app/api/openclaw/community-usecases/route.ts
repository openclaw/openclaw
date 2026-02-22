import { NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { getCommunityUsecaseCatalog } from "@/lib/community-catalog";

export const GET = withApiGuard(async () => {
  try {
    const catalog = getCommunityUsecaseCatalog();
    return NextResponse.json({
      usecases: catalog.usecases.map((item) => ({
        id: item.id,
        slug: item.slug,
        title: item.title,
        summary: item.summary,
        category: item.category,
        rating: item.rating,
        tags: item.tags,
        url: item.url,
        source: item.source,
        sourceDetail: item.sourceDetail,
      })),
      total: catalog.total,
      generatedAt: catalog.generatedAt,
      sourceZips: catalog.sourceZips || [],
    });
  } catch (error) {
    return handleApiError(error, "Failed to load community usecase catalog");
  }
}, ApiGuardPresets.read);
