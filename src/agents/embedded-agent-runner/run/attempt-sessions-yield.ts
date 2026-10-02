import type { AssistantMessage, AssistantMessageEventStreamLike } from "../../../llm/types.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionManager } from "../../sessions/index.js";
import { buildUsageWithNoCost } from "../../stream-message-shared.js";
import { isRunnerAbortError } from "../abort.js";

const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";

// Return a synthetic aborted response so agent runtime unwinds without a real provider call.
export function createYieldAbortedResponse(model: {
  api?: string;
  provider?: string;
  id?: string;
}): AssistantMessageEventStreamLike {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "aborted",
    api: model.api ?? "",
    provider: model.provider ?? "",
    model: model.id ?? "",
    usage: buildUsageWithNoCost({}),
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message,
  };
}

// sessions_yield ends the turn as a clean handoff, not an interruption.
// turnHandoff:true tells agent-core to skip <turn_aborted> guidance
// (packages/agent-core/src/turn-interruption.ts); code keys the runner's
// own yield checks in attempt.ts and attempt-stream.ts.
export const SESSIONS_YIELD_ABORT_REASON = { code: "sessions_yield", turnHandoff: true } as const;

export function isSessionsYieldAbortError(err: unknown): boolean {
  return isRunnerAbortError(err) && err instanceof Error && isSessionsYieldAbortReason(err.cause);
}

export function isSessionsYieldAbortReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { code?: unknown }).code === "sessions_yield"
  );
}

// Queue a hidden steering message so agent runtime injects it before the next
// LLM call once the current assistant turn finishes executing its tool calls.
export function queueSessionsYieldInterruptMessage(activeSession: {
  agent: { steer: (message: AgentMessage) => void };
}) {
  activeSession.agent.steer({
    role: "custom",
    customType: SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
    content: "[sessions_yield interrupt]",
    display: false,
    details: { source: "sessions_yield" },
    timestamp: Date.now(),
  });
}

// Remove the synthetic yield interrupt + aborted assistant entry from the live transcript.
// After strip, the transcript must end with a non-assistant role so subagent
// completion auto-announce can inject a continuation turn.
export function stripSessionsYieldArtifacts(activeSession: {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
  sessionManager: Pick<SessionManager, "removeTrailingEntries">;
}): boolean {
  const strippedMessages = activeSession.messages.slice();

  // The tool-calling assistant turn and synthetic abort artifacts form one
  // non-continuable suffix after sessions_yield.
  while (strippedMessages.length > 0) {
    const last = strippedMessages.at(-1);
    const removable =
      last?.role === "assistant" ||
      (last?.role === "custom" && last.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE);
    if (!removable) {
      break;
    }
    strippedMessages.pop();
  }

  const removedMessages = activeSession.messages.slice(strippedMessages.length);
  if (removedMessages.length === 0) {
    return false;
  }

  // The interrupt marker can settle independently in live and persisted state.
  // Only assistant removals need the live-suffix cap to prevent data loss.
  let remainingAssistantCount = removedMessages.filter(
    (message) => message.role === "assistant",
  ).length;
  const removedEntries = activeSession.sessionManager.removeTrailingEntries(
    (entry) => {
      if (
        entry.type === "custom_message" &&
        entry.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE
      ) {
        return true;
      }
      if (
        entry.type !== "message" ||
        entry.message.role !== "assistant" ||
        remainingAssistantCount === 0
      ) {
        return false;
      }
      remainingAssistantCount -= 1;
      return true;
    },
    {
      preserveTrailing: (entry) =>
        entry.type === "custom" ||
        entry.type === "label" ||
        entry.type === "session_info" ||
        (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
    },
  );
  activeSession.agent.state.messages = strippedMessages;
  return removedEntries > 0;
}
