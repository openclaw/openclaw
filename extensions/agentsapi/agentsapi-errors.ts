import OpenAI from "openai";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Customer-safe native failure facts remain available to host result classification. */
export class AgentsApiError extends Error {
  readonly code: string | null | undefined;
  readonly status: number | undefined;
  readonly type: string | undefined;
  readonly param: string | null | undefined;

  constructor(
    message: string,
    details: {
      code?: string | null;
      status?: number;
      type?: string;
      param?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "AgentsApiError";
    this.code = details.code;
    this.status = details.status;
    this.type = details.type;
    this.param = details.param;
  }
}

export function resolveAgentsApiSessionAccessError(
  error: unknown,
  sessionId: string | undefined,
): unknown {
  if (!sessionId || !(error instanceof OpenAI.APIError)) {
    return error;
  }
  const nativeMessage = asOptionalRecord(error.error)?.message;
  let userMessage: string;
  if (
    error instanceof OpenAI.NotFoundError &&
    nativeMessage === `No managed agent resource found: ${sessionId}`
  ) {
    userMessage =
      "Agents API could not find the saved session or this API key cannot access it. Check that the key belongs to the session's project and has the required permissions, then retry.";
  } else if (
    error instanceof OpenAI.PermissionDeniedError &&
    nativeMessage === "hosted session input requires the API key that created its CCA thread"
  ) {
    userMessage =
      "Agents API currently requires the original API key to send input to this hosted session. Restore that key, then retry to continue the same session.";
  } else {
    return error;
  }
  // Changing models cannot repair session access. Retain the SDK failure for diagnostics.
  return new AgentHarnessPreflightError(error.message, { cause: error, userMessage });
}

export function isAgentsApiTransportDisconnect(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AgentsApiError) {
    return false;
  }
  const code = asOptionalRecord(error)?.code;
  if (
    (typeof code === "string" &&
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(code)) ||
    (error instanceof TypeError && ["terminated", "fetch failed"].includes(error.message))
  ) {
    return true;
  }
  return error.cause instanceof Error && isAgentsApiTransportDisconnect(error.cause);
}

export function isAgentsApiOptionalHistoryReadFailure(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIConnectionError ||
    (error instanceof OpenAI.APIError && (error.status === 429 || (error.status ?? 0) >= 500))
  );
}
