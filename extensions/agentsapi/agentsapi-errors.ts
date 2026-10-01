import OpenAI from "openai";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

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
