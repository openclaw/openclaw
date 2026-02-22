import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import {
  handleApiError,
  isGatewayUnavailableError,
  isGatewayUnsupportedMethodError,
} from "@/lib/errors";
import { chatAnalyticsSchema, parseOrThrow } from "@/lib/schemas";

const DEFAULT_AGENT = "main";

function resolveSessionKey(raw?: string | null): string {
  if (raw && raw.startsWith("agent:")) {return raw;}
  const suffix = raw || "mission-control:chat";
  return `agent:${DEFAULT_AGENT}:${suffix}`;
}

export const POST = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatAnalyticsSchema, await req.json());
    const client = getOpenClawClient();
    await client.connect();

    const result = await client.getChatAnalytics({
      ...payload,
      sessionKey: payload.sessionKey
        ? resolveSessionKey(payload.sessionKey)
        : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        messagesPerDay: [],
        messagesByChannel: [],
        tokensByModel: [],
        degraded: true,
        warning:
          "Gateway unavailable. Chat analytics are temporarily unavailable.",
      });
    }
    if (isGatewayUnsupportedMethodError(error, "chat.analytics")) {
      return NextResponse.json({
        messagesPerDay: [],
        messagesByChannel: [],
        tokensByModel: [],
        degraded: true,
        warning: "Gateway version does not support chat.analytics yet. Upgrade gateway.",
      });
    }
    return handleApiError(error, "Failed to load chat analytics");
  }
}, ApiGuardPresets.read);
