import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import {
  handleApiError,
  isGatewayUnavailableError,
  isGatewayUnsupportedMethodError,
} from "@/lib/errors";
import { chatSearchSchema, parseOrThrow } from "@/lib/schemas";

const DEFAULT_AGENT = "main";

function resolveSessionKey(raw?: string | null): string {
  if (raw && raw.startsWith("agent:")) {return raw;}
  const suffix = raw || "mission-control:chat";
  return `agent:${DEFAULT_AGENT}:${suffix}`;
}

export const POST = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatSearchSchema, await req.json());
    const client = getOpenClawClient();
    await client.connect();

    const sessionKey = payload.sessionKey
      ? resolveSessionKey(payload.sessionKey)
      : undefined;

    const result = await client.searchChat({
      ...payload,
      sessionKey,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        results: [],
        nextOffset: undefined,
        degraded: true,
        warning:
          "Gateway unavailable. Chat search is temporarily unavailable.",
      });
    }
    if (isGatewayUnsupportedMethodError(error, "chat.search")) {
      return NextResponse.json({
        results: [],
        nextOffset: undefined,
        degraded: true,
        warning: "Gateway version does not support chat.search yet. Upgrade gateway.",
      });
    }
    return handleApiError(error, "Failed to search chat history");
  }
}, ApiGuardPresets.read);
