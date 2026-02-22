import { NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";

function toTimestamp(value: string | undefined): number {
  if (!value) {return 0;}
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toLabel(key: string): string {
  if (!key) {return "Untitled Session";}
  const compact = key.replace(/^agent:[^:]+:/, "");
  return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact;
}

export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();

    const sessions = await client.listSessions();
    const normalized = sessions
      .filter((session) => !!session.key)
      .toSorted(
        (a, b) => toTimestamp(b.lastActivity) - toTimestamp(a.lastActivity)
      )
      .slice(0, 50)
      .map((session) => ({
        id: session.key,
        key: session.key,
        label: toLabel(session.key),
        lastActive: session.lastActivity ?? null,
        model: session.model ?? null,
        provider: session.provider ?? null,
        tokenCount: session.totalTokens ?? 0,
        totalTokens: session.totalTokens ?? 0,
      }));

    return NextResponse.json({ sessions: normalized });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        sessions: [],
        degraded: true,
        warning:
          "Gateway unavailable. Session inventory is temporarily unavailable.",
      });
    }
    return handleApiError(error, "Failed to fetch gateway sessions");
  }
}, ApiGuardPresets.read);
