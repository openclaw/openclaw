import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import {
  isRecoverableModelError,
  retrySendMessageWithFallback,
} from "@/lib/model-fallback";
import { getSpecializedAgent } from "@/lib/agent-registry";
import { buildSpecialistExecutionContext } from "@/lib/specialist-intelligence";
import { directChatCompletion } from "@/lib/direct-provider";
import {
  chatAbortSchema,
  chatHistoryQuerySchema,
  chatSendSchema,
  parseOrThrow,
} from "@/lib/schemas";

const DEFAULT_AGENT = "main";
const SEND_TIMEOUT_MS = 8000;

/**
 * Build a proper session key that the gateway can route to an agent.
 * Gateway canonicalizes as: agent:<agentId>:<sessionKey>
 */
function resolveSessionKey(raw?: string | null): string {
  if (raw && raw.startsWith("agent:")) {return raw;}
  const suffix = raw || "mission-control:chat";
  return `agent:${DEFAULT_AGENT}:${suffix}`;
}

function extractAgentId(sessionKey: string): string | null {
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] ?? null;
}

/**
 * GET /api/chat — fetch chat history for a session.
 */
export const GET = withApiGuard(async (req: NextRequest) => {
  try {
    const query = parseOrThrow(chatHistoryQuerySchema, {
      sessionKey: req.nextUrl.searchParams.get("sessionKey") ?? undefined,
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    });
    const sessionKey = resolveSessionKey(query.sessionKey);
    const limit = query.limit ?? 50;

    const client = getOpenClawClient();
    await client.connect();
    const messages = await client.getChatHistory(sessionKey, { limit });
    return NextResponse.json({ messages, sessionKey });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        messages: [],
        sessionKey: resolveSessionKey(
          req.nextUrl.searchParams.get("sessionKey") ?? null
        ),
        degraded: true,
        warning:
          "Gateway unavailable. Chat history is temporarily unavailable.",
      });
    }
    return handleApiError(error, "Failed to fetch chat history");
  }
}, ApiGuardPresets.read);

/**
 * POST /api/chat — queue a message quickly and return without holding
 * the route for up to 120s.
 *
 * Behavior:
 * - Sends message to gateway.
 * - Returns quickly with queued/run metadata.
 * - The UI consumes live chat events from /api/openclaw/events.
 */
export const POST = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatSendSchema, await req.json());

    const sessionKey = resolveSessionKey(
      payload.sessionKey ?? null
    );

    const client = getOpenClawClient();
    await client.connect();
    const sanitizedMessage = sanitizeInput(payload.message);
    let outboundMessage = sanitizedMessage;

    // If this is the first message in a specialist chat session,
    // inject specialist role + adaptive quality context.
    const agentId = extractAgentId(sessionKey);
    if (agentId) {
      const specialist = getSpecializedAgent(agentId);
      if (specialist) {
        try {
          const history = await client.getChatHistory(sessionKey, { limit: 40 });
          const hasConversation = history.some(
            (msg) => msg.role === "user" || msg.role === "assistant"
          );
          if (!hasConversation) {
            const roleContext = specialist.systemPrompt.slice(0, 7000);
            const adaptiveContext = buildSpecialistExecutionContext(specialist.id);
            outboundMessage = `## Specialist Role

${roleContext}

${adaptiveContext}

## User Request

${sanitizedMessage}`;
          }
        } catch {
          // Best effort only; never block user chat on context injection.
        }
      }
    }

    let modelWarning: string | null = null;
    if (payload.model) {
      try {
        await client.patchSession(sessionKey, { model: payload.model });
      } catch (patchError) {
        if (!isRecoverableModelError(patchError)) {
          throw patchError;
        }
        modelWarning = `Requested model "${payload.model}" is unavailable. Using session default model instead.`;
      }
    }

    // Resolve timeout separately while avoiding unhandled rejections if send settles later.
    const sendPromise = client
      .sendMessage(sessionKey, outboundMessage)
      .then((payload) => ({ status: "sent" as const, payload }))
      .catch((error) => ({ status: "error" as const, error }));

    const sendResult = await Promise.race([
      sendPromise,
      new Promise<{ status: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ status: "timeout" }), SEND_TIMEOUT_MS)
      ),
    ]);

    let fallbackModelRef: string | null = null;
    let queuedPayload: unknown =
      sendResult.status === "sent" ? sendResult.payload : null;

    if (sendResult.status === "error") {
      const fallback = await retrySendMessageWithFallback({
          client,
          sessionKey,
          message: outboundMessage,
          originalError: sendResult.error,
        });
      if (!fallback) {
        // Gateway completely unreachable — try direct provider as last resort
        if (isGatewayUnavailableError(sendResult.error)) {
          try {
            const directResult = await directChatCompletion(
              [{ role: "user", content: outboundMessage }],
              { model: payload.model || undefined }
            );
            const data = await directResult.response.json();
            return NextResponse.json({
              queued: false,
              direct: true,
              provider: directResult.provider,
              data,
              sessionKey,
              warning:
                "Gateway unreachable — responded via direct provider fallback.",
            });
          } catch (directErr) {
            console.warn("[chat] Direct provider fallback also failed:", directErr);
          }
        }
        throw sendResult.error;
      }
      fallbackModelRef = fallback.modelRef;
      queuedPayload = { status: "started" };
    }

    const runId =
      typeof queuedPayload === "object" &&
      queuedPayload !== null &&
      "runId" in queuedPayload &&
      typeof (queuedPayload as Record<string, unknown>).runId === "string"
        ? ((queuedPayload as Record<string, unknown>).runId as string)
        : null;

    const status =
      typeof queuedPayload === "object" &&
      queuedPayload !== null &&
      "status" in queuedPayload &&
      typeof (queuedPayload as Record<string, unknown>).status === "string"
        ? ((queuedPayload as Record<string, unknown>).status as string)
        : "queued";

    return NextResponse.json(
      {
        queued: true,
        sessionKey,
        runId,
        status,
        fallbackModel: fallbackModelRef,
        warning: modelWarning,
      },
      { status: 202 }
    );
  } catch (error) {
    return handleApiError(error, "Failed to send message");
  }
}, ApiGuardPresets.llm);

/**
 * DELETE /api/chat — abort an active chat run for a session.
 */
export const DELETE = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatAbortSchema, await req.json());
    const sessionKey = resolveSessionKey(payload.sessionKey ?? null);
    const client = getOpenClawClient();
    await client.connect();
    await client.abortChat(sessionKey, payload.runId);
    return NextResponse.json({ ok: true, sessionKey, runId: payload.runId ?? null });
  } catch (error) {
    return handleApiError(error, "Failed to abort chat");
  }
}, ApiGuardPresets.llm);
