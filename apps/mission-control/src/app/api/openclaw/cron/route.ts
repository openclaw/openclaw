import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError, UserError } from "@/lib/errors";
import { cronActionSchema, parseOrThrow } from "@/lib/schemas";

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const client = getOpenClawClient();
    await client.connect();

    const { searchParams } = new URL(request.url);
    const runsFor = searchParams.get("runs");

    if (runsFor) {
      const runs = await client.cronRuns(runsFor);
      return NextResponse.json({ runs });
    }

    const jobs = await client.listCronJobs();
    return NextResponse.json({ jobs });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      const runsFor = request.nextUrl.searchParams.get("runs");
      if (runsFor) {
        return NextResponse.json({
          runs: [],
          degraded: true,
          warning: "Gateway unavailable. Cron run history is temporarily unavailable.",
        });
      }
      return NextResponse.json({
        jobs: [],
        degraded: true,
        warning: "Gateway unavailable. Cron jobs are temporarily unavailable.",
      });
    }
    return handleApiError(error, "Failed to fetch cron data");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(cronActionSchema, await request.json());

    const client = getOpenClawClient();
    await client.connect();

    if (payload.action === "add") {
      const job = await client.addCronJob({
        prompt: payload.prompt,
        schedule: payload.schedule,
        agentId: payload.agentId,
        sessionKey: payload.sessionKey,
        enabled: payload.enabled,
      });
      return NextResponse.json({ ok: true, job });
    }
    if (payload.action === "run") {
      const result = await client.runCronJob(payload.id, payload.mode);
      return NextResponse.json({ ok: true, result });
    }
    if (payload.action === "update") {
      const normalizedPatch: Partial<{
        prompt: string;
        schedule: string;
        enabled: boolean;
      }> = {};
      if (typeof payload.prompt === "string" && payload.prompt.length > 0) {
        normalizedPatch.prompt = payload.prompt;
      }
      if (typeof payload.schedule === "string" && payload.schedule.length > 0) {
        normalizedPatch.schedule = payload.schedule;
      }
      if (typeof payload.enabled === "boolean") {normalizedPatch.enabled = payload.enabled;}
      if (Object.keys(normalizedPatch).length === 0) {
        throw new UserError("No fields to update", 400);
      }

      const job = await client.updateCronJob(payload.id, normalizedPatch);
      return NextResponse.json({ ok: true, job });
    }
    if (payload.action === "remove") {
      await client.removeCronJob(payload.id);
      return NextResponse.json({ ok: true });
    }

    throw new UserError("Unknown action", 400);
  } catch (error) {
    return handleApiError(error, "Failed to process cron operation");
  }
}, ApiGuardPresets.write);
