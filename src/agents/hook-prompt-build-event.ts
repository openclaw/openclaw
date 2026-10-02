import type { PluginHookBeforePromptBuildEvent } from "../plugins/hook-before-agent-start.types.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";

/** Native current-input facts a host can bind to the prompt boundary event. */
export type PromptBuildHookCurrentUserMessage =
  | string
  | Pick<PersistedUserTurnMessage, "content" | "idempotencyKey">;

function resolveCurrentUserMessageText(value: PromptBuildHookCurrentUserMessage): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  return value.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/**
 * Builds the public prompt boundary event from the host's admitted request.
 *
 * `currentUserMessage` is the request before history/context projection, so it
 * must not be derived from the assembled model prompt. The recorder-owned
 * message carries both the text and its stable admission identity: an explicit
 * empty string stays present because it means "no textual request" (for example
 * image-only input), while omitting the fields is reserved for callers that hold
 * no admitted request, so legacy producers keep their behavior.
 */
export function buildPromptBuildHookEvent(params: {
  prompt: string;
  messages: unknown[];
  currentUserMessage?: PromptBuildHookCurrentUserMessage;
  currentUserMessageId?: string;
}): PluginHookBeforePromptBuildEvent {
  const currentUserMessage = params.currentUserMessage;
  const currentUserMessageId =
    params.currentUserMessageId ??
    (typeof currentUserMessage === "object" ? currentUserMessage.idempotencyKey : undefined);
  return {
    prompt: params.prompt,
    ...(currentUserMessage !== undefined
      ? { currentUserMessage: resolveCurrentUserMessageText(currentUserMessage) }
      : {}),
    ...(typeof currentUserMessageId === "string" ? { currentUserMessageId } : {}),
    messages: params.messages,
  };
}
