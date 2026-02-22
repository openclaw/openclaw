import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getOpenClawClient, type ChatMessage } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import { chatCouncilSchema, parseOrThrow } from "@/lib/schemas";

const DEFAULT_AGENT = "main";
const POLL_INTERVAL_MS = 1_200;
const POLL_TIMEOUT_MS = 45_000;

function resolveSessionKey(raw?: string | null): string {
  if (raw && raw.startsWith("agent:")) {return raw;}
  const suffix = raw || "mission-control:chat";
  return `agent:${DEFAULT_AGENT}:${suffix}`;
}

function buildCouncilSessionKey(baseSessionKey: string, model: string, index: number): string {
  const normalizedBase = resolveSessionKey(baseSessionKey).slice(0, 120);
  const modelHash = createHash("sha1").update(model).digest("hex").slice(0, 10);
  return `${normalizedBase}:council:${Date.now().toString(36)}:${index}:${modelHash}`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {return content.trim();}
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") {return entry;}
        if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
          return (entry as Record<string, unknown>).text as string;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && typeof (content as Record<string, unknown>).text === "string") {
    return ((content as Record<string, unknown>).text as string).trim();
  }
  return String(content ?? "").trim();
}

async function waitForAssistantReply(
  sessionKey: string
): Promise<ChatMessage | null> {
  const client = getOpenClawClient();
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const history = await client.getChatHistory(sessionKey, { limit: 16 });
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === "assistant") {
        return history[i];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

/**
 * POST /api/chat/council
 * Sends one prompt to multiple models in parallel and returns each response.
 */
export const POST = withApiGuard(async (req: NextRequest) => {
  try {
    const payload = parseOrThrow(chatCouncilSchema, await req.json());
    const baseSessionKey = resolveSessionKey(payload.sessionKey ?? null);
    const message = sanitizeInput(payload.message);
    const models = Array.from(new Set(payload.models.map((m) => m.trim()).filter(Boolean)));

    const client = getOpenClawClient();
    await client.connect();

    const runs = models.map(async (model, index) => {
      const sessionKey = buildCouncilSessionKey(baseSessionKey, model, index);
      try {
        await client.patchSession(sessionKey, { model });
        await client.sendMessage(sessionKey, message);
        const assistant = await waitForAssistantReply(sessionKey);

        if (!assistant) {
          return {
            model,
            sessionKey,
            ok: false,
            error: "Timed out waiting for model response",
          };
        }

        return {
          model,
          sessionKey,
          ok: true,
          message: extractText(assistant.content),
          timestamp: assistant.timestamp ?? new Date().toISOString(),
        };
      } catch (error) {
        return {
          model,
          sessionKey,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const results = await Promise.all(runs);
    return NextResponse.json({
      sourceSessionKey: baseSessionKey,
      models,
      results,
    });
  } catch (error) {
    return handleApiError(error, "Failed to run council");
  }
}, ApiGuardPresets.llm);
