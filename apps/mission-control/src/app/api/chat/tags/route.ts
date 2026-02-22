import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import {
  handleApiError,
  isGatewayUnavailableError,
  isGatewayUnsupportedMethodError,
} from "@/lib/errors";
import { chatTagsPatchSchema, chatTagsQuerySchema, parseOrThrow } from "@/lib/schemas";

const DEFAULT_AGENT = "main";

function resolveSessionKey(raw?: string | null): string {
  if (raw && raw.startsWith("agent:")) {return raw;}
  const suffix = raw || "mission-control:chat";
  return `agent:${DEFAULT_AGENT}:${suffix}`;
}

export const GET = withApiGuard(async (req: NextRequest) => {
  try {
    const query = parseOrThrow(chatTagsQuerySchema, {
      sessionKey: req.nextUrl.searchParams.get("sessionKey") ?? undefined,
    });
    const sessionKey = resolveSessionKey(query.sessionKey);

    const client = getOpenClawClient();
    await client.connect();
    let tags: string[] = [];
    try {
      tags = await client.getSessionTags(sessionKey);
    } catch (error) {
      if (isGatewayUnsupportedMethodError(error, "sessions.tags")) {
        return NextResponse.json({
          sessionKey,
          tags: [],
          degraded: true,
          warning:
            "Gateway version does not support sessions.tags yet. Upgrade gateway to enable tag reads.",
        });
      }
      throw error;
    }

    return NextResponse.json({ sessionKey, tags });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        sessionKey: resolveSessionKey(
          req.nextUrl.searchParams.get("sessionKey") ?? null
        ),
        tags: [],
        degraded: true,
        warning:
          "Gateway unavailable. Session tags are temporarily unavailable.",
      });
    }
    return handleApiError(error, "Failed to load session tags");
  }
}, ApiGuardPresets.read);

export const PATCH = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatTagsPatchSchema, await req.json());
    const sessionKey = resolveSessionKey(payload.sessionKey);

    const client = getOpenClawClient();
    await client.connect();
    await client.patchSession(sessionKey, { tags: payload.tags });
    let tags = payload.tags;
    try {
      tags = await client.getSessionTags(sessionKey);
    } catch (error) {
      if (isGatewayUnsupportedMethodError(error, "sessions.tags")) {
        return NextResponse.json({
          ok: true,
          sessionKey,
          tags: payload.tags,
          degraded: true,
          warning:
            "Tags were updated, but this gateway cannot read tags yet (sessions.tags unsupported).",
        });
      }
      throw error;
    }

    return NextResponse.json({ ok: true, sessionKey, tags });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        ok: false,
        sessionKey: null,
        tags: [],
        degraded: true,
        warning:
          "Gateway unavailable. Session tags could not be updated.",
      });
    }
    return handleApiError(error, "Failed to update session tags");
  }
}, ApiGuardPresets.write);
