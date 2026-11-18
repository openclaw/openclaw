import { textResult } from "openclaw/plugin-sdk/tool-results";

export function jsonActionResult(
  data: Record<string, unknown>,
  details: Record<string, unknown> = data,
) {
  return textResult(JSON.stringify(data), details);
}

export function jsonMSTeamsActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ channel: "msteams", action, ...data });
}

export function jsonMSTeamsOkActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ ok: true, channel: "msteams", action, ...data });
}

export function jsonMSTeamsConversationResult(conversationId: string | undefined) {
  return jsonActionResult(
    {
      ok: true,
      channel: "msteams",
      conversationId,
    },
    { ok: true, channel: "msteams" },
  );
}

export function actionError(message: string) {
  return {
    isError: true as const,
    ...textResult(message, { error: message }),
  };
}
