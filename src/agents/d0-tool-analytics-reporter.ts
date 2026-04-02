import { parseAgentSessionKey } from "../routing/session-key.js";

type D0ToolLifecyclePayload = {
  toolName: string;
  toolDetail?: string;
  resultChars?: number;
  status: "success" | "error";
  runId: string;
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  durationMs?: number;
  error?: string;
  occurredAt?: string;
};

type D0ToolLifecycleContext = {
  sessionKey?: string;
  sessionId?: string;
};

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isTelegramAgentSession(sessionKey: string | undefined): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  return Boolean(parsed?.rest.startsWith("telegram:"));
}

function isD0TrackedSession(sessionKey: string | undefined): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return (
    parsed.agentId === "main" &&
    (parsed.rest === "main" ||
      parsed.rest.startsWith("main:") ||
      parsed.rest.startsWith("telegram:"))
  );
}

export async function reportD0ToolLifecycle(
  payload: D0ToolLifecyclePayload,
  context: D0ToolLifecycleContext,
): Promise<boolean> {
  const backendBaseUrl = trimToUndefined(process.env.D0_BACKEND_INTERNAL_URL);
  const gatewayToken = trimToUndefined(process.env.OPENCLAW_GATEWAY_TOKEN);
  const sessionKey = payload.sessionKey ?? context.sessionKey;
  const sessionIsAllowed = isTelegramAgentSession(sessionKey) || isD0TrackedSession(sessionKey);

  if (!backendBaseUrl || !gatewayToken || !sessionIsAllowed) {
    return false;
  }

  const response = await fetch(
    `${backendBaseUrl.replace(/\/$/, "")}/v1/backend/d0/tool-analytics`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        toolName: payload.toolName,
        toolDetail: payload.toolDetail,
        status: payload.status,
        runId: payload.runId,
        toolCallId: payload.toolCallId,
        sessionKey,
        sessionId: payload.sessionId ?? context.sessionId,
        durationMs: payload.durationMs,
        error: payload.error,
        resultChars: payload.resultChars,
        occurredAt: payload.occurredAt ?? new Date().toISOString(),
      }),
    },
  ).catch(() => null);

  return Boolean(response?.ok);
}
