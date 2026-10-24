import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { prepareAgentRunTerminalReply as prepareReply } from "../../agent-run-terminal-reply.js";
import type { PreparedSettledTurnFinalizationResult } from "../../harness/settled-turn-finalization-outcome.js";
import { buildEmbeddedRunnerAssistant } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";

type Assistant = ReturnType<typeof buildEmbeddedRunnerAssistant>;
type Call = [id: string, name: string, isError?: boolean];

export function textAssistant(text?: string, overrides: Partial<Assistant> = {}) {
  return buildEmbeddedRunnerAssistant({
    content: text === undefined ? [] : [{ type: "text", text }],
    ...overrides,
  });
}

export function toolAssistant(...calls: Call[]) {
  return buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
  });
}

export function settledBatch(...calls: Call[]) {
  const assistant = toolAssistant(...calls);
  return {
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    itemLifecycle: { startedCount: calls.length, completedCount: calls.length, activeCount: 0 },
    messagesSnapshot: [
      assistant,
      ...calls.map(([id, name, error = false]) => makeTextToolResult(id, name, "", error, 0)),
    ],
  };
}

export function finalizationReply(
  outcome: "answered" | "empty",
  text?: string,
  result: Partial<PreparedSettledTurnFinalizationResult> = {},
) {
  return {
    outcome,
    result: {
      ...result,
      assistant: result.assistant ?? textAssistant(text),
      preparedTerminalReply: prepareReply(text === undefined ? {} : { rawText: text }),
    },
  };
}
