// Per-turn send-budget QA fixtures (QA-PTSB-SEND / QA-PTSB-REPEAT), split out of
// server.ts to keep that grandfathered mock-provider file within its line cap. The
// caller passes its own scenario event builders so these fixtures emit through the exact
// same tool-call/assistant event path as the rest of the provider.
import type { ResponsesInputItem } from "./mock-openai-contracts.js";
import {
  extractPerTurnSendBudgetDirective,
  extractPerTurnSendBudgetRepeatDirective,
} from "./mock-openai-directives.js";
import { extractLastMatchingUserTurn } from "./mock-openai-input.js";

export function resolvePerTurnSendBudgetResponse<T>(params: {
  input: ResponsesInputItem[];
  hasDeclaredTool: (tool: string) => boolean;
  buildToolCallEventsWithArgs: (name: string, args: Record<string, unknown>) => T;
  buildDuplicateToolCallEventsWithArgs: (
    name: string,
    args: Record<string, unknown>,
    count: number,
  ) => T;
  buildAssistantEvents: (text: string) => T;
}): T | undefined {
  // Both fixtures are turn-scoped: the directive is read from the latest user turn only and
  // only calls planned after it count. A session that runs several QA-PTSB turns replays
  // earlier turns' directives and calls in its transcript; reading the whole transcript
  // would resolve an older turn's directive and count its sends.
  const turn = extractLastMatchingUserTurn(params.input);
  if (!turn) {
    return undefined;
  }
  const turnItems = params.input.slice(turn.index + 1);
  // Per-turn send-budget fixture (QA-PTSB-SEND): emit one `message`/`conversations_send`
  // per continuation round to the same target until `count` sends have been planned this
  // turn, then finalize with text. Placed before the scenario chain so the unique marker
  // wins outright; counting this turn's planned calls is how one turn fans out into
  // several sequential sends that all charge the same run-scoped ledger slot.
  const perTurnSendBudget = extractPerTurnSendBudgetDirective(turn.text);
  if (perTurnSendBudget && params.hasDeclaredTool(perTurnSendBudget.tool)) {
    const priorPlannedSends = turnItems.filter(
      (item) => item.type === "function_call" && item.name === perTurnSendBudget.tool,
    ).length;
    if (priorPlannedSends < perTurnSendBudget.count) {
      const sequence = priorPlannedSends + 1;
      // `reject` emits an empty message, which the message tool rejects ("send requires
      // text or media or location") after the budget reserved it; that send must not
      // charge the per-turn budget. Any other outcome sends a visible markered payload.
      const outcome = perTurnSendBudget.outcomes?.[sequence - 1] ?? "ok";
      const rejected = outcome === "reject";
      const sendArgs =
        perTurnSendBudget.tool === "conversations_send"
          ? {
              conversationRef: perTurnSendBudget.ref,
              message: `${perTurnSendBudget.marker}-${sequence}`,
            }
          : {
              action: "send",
              message: rejected ? "" : `${perTurnSendBudget.marker}-${sequence}`,
              // In message_tool_only mode a delivered source-reply send with
              // `final !== false` terminates the turn (resolveMessageToolSourceReplyFinal
              // in embedded-agent-message-tool-source-reply.ts). This fixture fans out
              // several sends in one turn, so each fan-out send marks itself non-final to
              // keep the run looping; the turn ends when the FINAL assistant text is
              // emitted after `count` sends. `final` is deleted before dispatch, so it
              // never reaches delivery — it only gates turn termination.
              final: false,
            };
      return params.buildToolCallEventsWithArgs(perTurnSendBudget.tool, sendArgs);
    }
    return params.buildAssistantEvents(`${perTurnSendBudget.marker}-FINAL`);
  }
  // Per-turn send-budget REPEAT fixture (QA-PTSB-REPEAT): emit the SAME `message`
  // send twice in ONE response (byte-identical args, distinct call_id/item id) on
  // the opening round, then finalize with text once the copies have run. Proves a
  // per-turn cap blocks the second byte-identical send (distinct idempotency key)
  // instead of admitting it as an idempotent replay. Placed beside QA-PTSB-SEND so
  // its unique marker wins before the scenario chain.
  const perTurnSendBudgetRepeat = extractPerTurnSendBudgetRepeatDirective(turn.text);
  if (perTurnSendBudgetRepeat && params.hasDeclaredTool("message")) {
    const priorMessageSends = turnItems.filter(
      (item) => item.type === "function_call" && item.name === "message",
    ).length;
    if (priorMessageSends === 0) {
      return params.buildDuplicateToolCallEventsWithArgs(
        "message",
        {
          action: "send",
          message: perTurnSendBudgetRepeat.marker,
          // Non-final so the run keeps looping to the finalizer after both copies
          // resolve; `final` is deleted before dispatch (see QA-PTSB-SEND) and so
          // never reaches delivery or idempotency derivation.
          final: false,
        },
        2,
      );
    }
    return params.buildAssistantEvents(`${perTurnSendBudgetRepeat.marker}-FINAL`);
  }
  return undefined;
}
