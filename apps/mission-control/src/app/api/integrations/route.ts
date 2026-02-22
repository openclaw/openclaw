import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import {
  integrationDeleteQuerySchema,
  integrationUpsertSchema,
  parseOrThrow,
} from "@/lib/schemas";
import {
  INTEGRATION_SERVICES,
  listIntegrationSummaries,
  removeIntegration,
  upsertIntegration,
} from "@/lib/integrations";

export const GET = withApiGuard(async () => {
  try {
    return NextResponse.json({
      integrations: listIntegrationSummaries(),
      supported: INTEGRATION_SERVICES,
    });
  } catch (error) {
    return handleApiError(error, "Failed to read integrations");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(integrationUpsertSchema, await request.json());
    upsertIntegration(payload);

    return NextResponse.json({
      ok: true,
      service: payload.service,
      integration: listIntegrationSummaries()[payload.service],
    });
  } catch (error) {
    return handleApiError(error, "Failed to save integration");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const parsed = parseOrThrow(integrationDeleteQuerySchema, {
      service: request.nextUrl.searchParams.get("service") ?? undefined,
    });
    const removed = removeIntegration(parsed.service);

    return NextResponse.json({
      ok: removed,
      service: parsed.service,
      integration: listIntegrationSummaries()[parsed.service],
    });
  } catch (error) {
    return handleApiError(error, "Failed to remove integration");
  }
}, ApiGuardPresets.write);

