import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";
import { parseOrThrow, usageQuerySchema } from "@/lib/schemas";

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { period: rawPeriod = "today" } = parseOrThrow(usageQuerySchema, {
      period: request.nextUrl.searchParams.get("period") ?? undefined,
    });
    const period =
      rawPeriod === "7d"
        ? "week"
        : rawPeriod === "30d"
          ? "month"
          : rawPeriod;

    const days =
      rawPeriod === "today" ? 1 : rawPeriod === "7d" ? 7 : rawPeriod === "30d" ? 30 : 1;

    const client = getOpenClawClient();
    await client.connect();

    const [usage, cost] = await Promise.allSettled([
      client.getUsage(),
      client.getUsageCost({ days }),
    ]);

    const costPayload = cost.status === "fulfilled" ? cost.value : null;
    const hasDaily =
      costPayload != null &&
      typeof costPayload === "object" &&
      Array.isArray((costPayload as Record<string, unknown>).daily) &&
      ((costPayload as Record<string, unknown>).daily as unknown[]).length > 0;

    return NextResponse.json({
      usage: usage.status === "fulfilled" ? usage.value : null,
      cost: costPayload,
      period: rawPeriod,
      normalizedPeriod: period,
      supportsHistoricalBreakdown: hasDaily,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        usage: null,
        cost: null,
        period: request.nextUrl.searchParams.get("period") ?? "today",
        normalizedPeriod: null,
        supportsHistoricalBreakdown: false,
        fetchedAt: new Date().toISOString(),
        degraded: true,
        warning:
          "Gateway is unavailable, so live usage data is temporarily unavailable.",
      });
    }
    return handleApiError(error, "Failed to fetch usage data");
  }
}, ApiGuardPresets.read);
