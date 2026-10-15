import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildStrictAnthropicReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const OMITTED_COPILOT_REASONING_TEXT = "[assistant reasoning omitted]";

function isThinkingBlock(value: unknown): boolean {
  const type = asOptionalObjectRecord(value)?.type;
  return type === "thinking" || type === "redacted_thinking";
}

export function stripCopilotAssistantThinkingMessages<T>(messages: T[]): T[] {
  let touched = false;
  const sanitized = messages.map((message) => {
    const record = asOptionalObjectRecord(message);
    if (record?.role !== "assistant" || !Array.isArray(record.content)) {
      return message;
    }
    const content = record.content.filter((block) => !isThinkingBlock(block));
    if (content.length === record.content.length) {
      return message;
    }
    touched = true;
    return {
      ...message,
      content:
        content.length > 0 ? content : [{ type: "text", text: OMITTED_COPILOT_REASONING_TEXT }],
    };
  });
  return touched ? sanitized : messages;
}

export function buildGithubCopilotReplayPolicy(
  ctx: ProviderReplayPolicyContext,
): ProviderReplayPolicy | undefined {
  if (ctx.modelApi !== "anthropic-messages") {
    return undefined;
  }
  return buildStrictAnthropicReplayPolicy({
    // Unconditional: Copilot strips replayed thinking for every Claude model, so
    // it never owns signed-thinking replay. The shared by-model helper would
    // re-enable it for thinking-preserving Claude ids.
    dropThinkingBlocks: true,
    // wrapCopilotAnthropicStream rewrites tool ids on the wire and deliberately
    // leaves the persisted transcript untouched. Core-side rewriting would
    // mutate that transcript instead.
    sanitizeToolCallIds: false,
  });
}

export function sanitizeGithubCopilotReplayHistory(ctx: ProviderSanitizeReplayHistoryContext) {
  return ctx.modelApi === "openai-responses" || ctx.modelApi === "anthropic-messages"
    ? stripCopilotAssistantThinkingMessages(ctx.messages)
    : ctx.messages;
}
