import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { resolveSourceReplyDeliveryMode } from "../../../auto-reply/reply/source-reply-delivery-mode.js";
import {
  buildMessageToolFinalityGuidance,
  buildMessageToolTargetGuidance,
} from "../../../auto-reply/source-reply-delivery-mode.js";
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
  messageToolFinalByDefault?: boolean;
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
        ? "This turn's final response is not automatically sent here. You MUST use `message(action=send)` for visible text replies here. If reactions are permitted, `message(action=react, final=true)` can complete the reply by adding a reaction to the current message. Without the message tool, no reply can be sent here."
        : "For this turn, reply normally in your final assistant message; OpenClaw delivers it here automatically. You MUST NOT send the same reply both with the message tool and in your final response.",
    );
  }
  const requireExplicitTarget =
    facts.requireExplicitMessageTarget ?? session.requireExplicitMessageTarget;
  if (requireExplicitTarget !== session.requireExplicitMessageTarget) {
    lines.push(`Message tool: ${buildMessageToolTargetGuidance(requireExplicitTarget)}`);
  }
  const finality = buildMessageToolFinalityGuidance(facts.messageToolFinalByDefault);
  if (finality) {
    lines.push(finality);
  }
  return lines.length > 0 ? [{ kind: "runtime-instruction", text: lines.join("\n") }] : [];
}
