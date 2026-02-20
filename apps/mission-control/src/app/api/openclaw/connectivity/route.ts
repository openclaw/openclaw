import { NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { isGatewayUnavailableError } from "@/lib/errors";

type CheckOutcome = {
  ok: boolean;
  error?: string;
};

function toOutcome(result: PromiseSettledResult<unknown>): CheckOutcome {
  if (result.status === "fulfilled") {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason ?? "Unknown error"),
  };
}

export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();

    const [health, agents, models, usageCost] =
      await Promise.allSettled([
        client.call("health", {}, 8000),
        client.call("agents.list", {}, 8000),
        client.call("models.list", {}, 8000),
        client.call("usage.cost", {}, 8000),
      ]);

    const modelsPayload = models.status === "fulfilled"
      ? ((models.value as { models?: Array<{ provider?: string }> }) || {})
      : {};
    const byProvider = new Map<string, number>();
    for (const model of modelsPayload.models || []) {
      const provider = model.provider || "unknown";
      byProvider.set(provider, (byProvider.get(provider) || 0) + 1);
    }

    return NextResponse.json({
      connected: true,
      checks: {
        health: toOutcome(health),
        agents: toOutcome(agents),
        models: toOutcome(models),
        usage: toOutcome(usageCost),
        usageCost: toOutcome(usageCost),
      },
      modelProviders: Object.fromEntries(byProvider.entries()),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const unavailable = isGatewayUnavailableError(error);
    return NextResponse.json({
      connected: false,
      degraded: true,
      checks: {
        gateway: {
          ok: false,
          error: unavailable
            ? "Gateway unavailable"
            : "Connectivity probe failed",
        },
      },
      modelProviders: {},
      checkedAt: new Date().toISOString(),
    });
  }
}, ApiGuardPresets.read);
