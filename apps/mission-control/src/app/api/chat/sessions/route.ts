import { NextRequest, NextResponse } from "next/server";
import {
  getOpenClawClient,
  type OpenClawSession,
} from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";
import {
  chatSessionDeleteSchema,
  chatSessionPatchSchema,
  chatSessionsQuerySchema,
  parseOrThrow,
} from "@/lib/schemas";
import { isRecoverableModelError } from "@/lib/model-fallback";

const DEFAULT_AGENT = "main";
const SESSION_PREFIX = `agent:${DEFAULT_AGENT}:`;

function normalizeSessionKey(raw: string): string {
  if (raw.startsWith("agent:")) {return raw;}
  return `${SESSION_PREFIX}${raw}`;
}

function toSessionLabel(key: string): string {
  const trimmed = key.startsWith(SESSION_PREFIX)
    ? key.slice(SESSION_PREFIX.length)
    : key;
  if (!trimmed) {return "Untitled Session";}
  if (trimmed.length <= 42) {return trimmed;}
  return `${trimmed.slice(0, 39)}...`;
}

function toTimestamp(value: string | undefined): number {
  if (!value) {return 0;}
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isMissionControlChatSession(key: string): boolean {
  if (!key.startsWith(SESSION_PREFIX)) {return false;}
  const suffix = key.slice(SESSION_PREFIX.length);
  return suffix === "mission-control:chat" || suffix.startsWith("mission-control:chat-");
}

function serializeSession(session: OpenClawSession): Record<string, unknown> {
  return {
    key: session.key,
    label: session.label ?? toSessionLabel(session.key),
    agentId: session.agentId ?? DEFAULT_AGENT,
    model: session.model ?? null,
    provider: session.provider ?? null,
    inputTokens: session.inputTokens ?? 0,
    outputTokens: session.outputTokens ?? 0,
    totalTokens: session.totalTokens ?? 0,
    lastActivity: session.lastActivity ?? null,
  };
}

/**
 * GET /api/chat/sessions
 * Returns recent sessions for the default main agent.
 */
export const GET = withApiGuard(async (req: NextRequest) => {
  try {
    const query = parseOrThrow(chatSessionsQuerySchema, {
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    });
    const limit = query.limit ?? 40;

    const client = getOpenClawClient();
    await client.connect();

    const sessions = await client.listSessions({ agentId: DEFAULT_AGENT });
    const deduped = new Map<string, OpenClawSession>();
    for (const session of sessions) {
      if (!session.key || !isMissionControlChatSession(session.key)) {continue;}
      const existing = deduped.get(session.key);
      if (!existing) {
        deduped.set(session.key, session);
        continue;
      }
      if (toTimestamp(session.lastActivity) > toTimestamp(existing.lastActivity)) {
        deduped.set(session.key, session);
      }
    }

    const filtered = Array.from(deduped.values())
      .toSorted(
        (a, b) => toTimestamp(b.lastActivity) - toTimestamp(a.lastActivity)
      )
      .slice(0, limit)
      .map((session) => serializeSession(session));

    return NextResponse.json({ sessions: filtered });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        sessions: [],
        degraded: true,
        warning:
          "Gateway is unavailable. Session list is temporarily empty until reconnection.",
      });
    }
    return handleApiError(error, "Failed to fetch chat sessions");
  }
}, ApiGuardPresets.read);

/**
 * DELETE /api/chat/sessions
 * Deletes an existing chat session.
 */
export const DELETE = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatSessionDeleteSchema, await req.json());
    const sessionKey = normalizeSessionKey(payload.sessionKey);
    const client = getOpenClawClient();
    await client.connect();
    await client.deleteSession(sessionKey);
    return NextResponse.json({ ok: true, sessionKey });
  } catch (error) {
    return handleApiError(error, "Failed to delete chat session");
  }
}, ApiGuardPresets.write);

/**
 * PATCH /api/chat/sessions
 * Updates session-level overrides (currently model override).
 */
export const PATCH = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatSessionPatchSchema, await req.json());
    const sessionKey = normalizeSessionKey(payload.sessionKey);
    const client = getOpenClawClient();
    await client.connect();
    let appliedModel: string | null = payload.model ?? null;
    let warning: string | null = null;
    let patched = false;
    const patch: Record<string, unknown> = {};
    if ("label" in payload) {
      patch.label = payload.label ?? null;
    }
    if ("tags" in payload) {
      patch.tags = payload.tags ?? [];
    }
    if ("model" in payload) {
      patch.model = payload.model ?? null;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "No fields to update",
        },
        { status: 400 },
      );
    }
    try {
      await client.patchSession(sessionKey, patch);
      patched = true;
    } catch (error) {
      if (!payload.model || !isRecoverableModelError(error)) {
        throw error;
      }

      // Revert to gateway default model when the selected model is not allowed.
      await client.patchSession(sessionKey, { ...patch, model: null });
      appliedModel = null;
      warning = `Requested model "${payload.model}" is unavailable. Reverted to auto model.`;
      patched = true;
    }

    return NextResponse.json({
      ok: true,
      sessionKey,
      model: appliedModel,
      appliedModel,
      label: payload.label ?? null,
      tags: payload.tags ?? null,
      warning,
      patched,
    });
  } catch (error) {
    return handleApiError(error, "Failed to update chat session");
  }
}, ApiGuardPresets.write);
