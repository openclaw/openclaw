import { selectBoundedContextStart } from "../../../config/sessions/session-bounded-context-selection.js";
import { resolveEffectiveCompactionReserveTokens } from "../../agent-compaction-constants.js";
import { PROJECTED_PROMPT_UPDATE } from "../../embedded-agent-helpers/turns.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { CompactionRequestBudget } from "../../sessions/compaction/preparation.types.js";
import {
  estimateCompactionHistoryTokens,
  estimateMessageTokenPressure,
  SAFETY_MARGIN,
} from "../../sessions/context-token-pressure.js";
import { makeZeroUsageSnapshot } from "../../usage.js";

// A model-view-only tag survives the replay pipeline's object spreads but not JSON/wire encoding.
const copied = Symbol("fork-working-context");

function isConversationRow(message: AgentMessage) {
  return (
    (message.role === "user" &&
      !message.operatorMessage &&
      !(PROJECTED_PROMPT_UPDATE in message)) ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

export function projectCopiedForkMessages(
  messages: AgentMessage[],
  inherited: WeakSet<AgentMessage>,
) {
  return messages.map((message, index) =>
    inherited.has(message) && isConversationRow(message)
      ? {
          ...message,
          [copied]: index,
          ...(message.role === "assistant" ? { usage: makeZeroUsageSnapshot() } : {}),
        }
      : message,
  );
}

/** Spend only the request capacity left after the current child and required carriers. */
export function boundForkWorkingContext(
  messages: AgentMessage[],
  budget: CompactionRequestBudget,
  outputTokens: number,
  projected = messages,
) {
  // Summaries and custom instructions stay exactly where their owners projected them.
  const history = projected.filter(isConversationRow);
  const protectedStart = history.findIndex((message) => !(copied in message));
  if (protectedStart === 0 || !history.length) {
    return messages;
  }
  const protectedMessages = projected.filter((message) => !(copied in message));
  const reserve = resolveEffectiveCompactionReserveTokens({
    contextTokenBudget: budget.contextWindow,
    reserveTokens: budget.reserveTokens,
  });
  const available =
    budget.contextWindow -
    Math.max(outputTokens, reserve) -
    budget.fixedTokens -
    budget.pendingTokens -
    estimateCompactionHistoryTokens(protectedMessages, budget);
  const cut = selectBoundedContextStart(
    history,
    undefined,
    Math.max(0, Math.floor(available / SAFETY_MARGIN)),
    (index) => ({
      bytes: 0,
      tokens: copied in history[index]! ? estimateMessageTokenPressure(history[index]!) : 0,
    }),
  );
  // The selection closes complete tool frames. Never split one to reach a cut, or
  // discard a local turn if local work itself now needs ordinary semantic compaction.
  if (!cut || (protectedStart >= 0 && cut > protectedStart)) {
    return messages;
  }
  const omitted = new Set(
    history.slice(0, cut).flatMap((message) => (copied in message ? [message[copied]] : [])),
  );
  return messages.filter((message) => !(copied in message) || !omitted.has(message[copied]));
}
