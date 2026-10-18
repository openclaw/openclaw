import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { resolveSourceReplyDeliveryMode } from "../../../auto-reply/reply/source-reply-delivery-mode.js";
import { buildMessageToolTargetGuidance } from "../../../auto-reply/source-reply-delivery-mode.js";
import type { ChatType } from "../../../channels/chat-type.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import type { RuntimeContextFragment } from "../../internal-runtime-context.js";

type TurnDeliveryFacts = {
  config?: OpenClawConfig;
  sessionKey?: string;
  chatType?: ChatType;
  channel?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
};

/**
 * Delivery facts the cached system prompt is built from. They depend only on the
 * session and config, so every turn kind shares one prompt prefix.
 */
export function resolveSessionPromptDelivery(facts: TurnDeliveryFacts): {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode;
  requireExplicitMessageTarget: boolean;
} {
  return {
    sourceReplyDeliveryMode: facts.config
      ? resolveSourceReplyDeliveryMode({
          cfg: facts.config,
          ctx: { ChatType: facts.chatType, Provider: facts.channel, Surface: facts.channel },
        })
      : "automatic",
    requireExplicitMessageTarget: isSubagentSessionKey(facts.sessionKey),
  };
}

/** States this turn's delivery rules where they differ from the session's cached prompt. */
export function buildTurnDeliveryContextFragments(
  facts: TurnDeliveryFacts,
): RuntimeContextFragment[] {
  const session = resolveSessionPromptDelivery(facts);
  const turnMode = facts.sourceReplyDeliveryMode ?? "automatic";
  const lines: string[] = [];
  if (turnMode !== session.sourceReplyDeliveryMode) {
    lines.push(
      turnMode === "message_tool_only"
        ? "This turn's final text is private. A visible reply to the current source MUST use `message(action=send)` (or a final reaction with `message(action=react, final=true)`); without the tool the user gets nothing."
        : "This turn's final text goes to the current source automatically. Do not also send it with the message tool.",
    );
  }
  const requireExplicitTarget =
    facts.requireExplicitMessageTarget ?? session.requireExplicitMessageTarget;
  if (requireExplicitTarget !== session.requireExplicitMessageTarget) {
    lines.push(`Message tool: ${buildMessageToolTargetGuidance(requireExplicitTarget)}`);
  }
  return lines.length > 0 ? [{ kind: "runtime-instruction", text: lines.join("\n") }] : [];
}
