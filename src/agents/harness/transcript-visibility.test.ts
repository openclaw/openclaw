import { expect, it } from "vitest";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./transcript-visibility.js";

const scheduled = { kind: "internal_system", sourceTool: "cron_execution" } as const;
const project = (message: AgentMessage, inputProvenance?: InputProvenance) =>
  projectAgentHarnessTranscriptMessageForDisplay({ hidden: false, inputProvenance, message });

it("hides scheduled artifacts without a run registry, but preserves errors and ordinary replies", () => {
  const input = { role: "user", content: "Check the queue", timestamp: 1 } as const;
  const reply = makeAgentAssistantMessage({ content: [{ type: "text", text: "Still waiting." }] });
  const call = makeAgentAssistantMessage({
    content: [
      { type: "toolCall", id: "call", name: "automations", arguments: { action: "record_result" } },
    ],
  });
  const result: AgentMessage = {
    role: "toolResult",
    toolCallId: "call",
    toolName: "automations",
    content: [{ type: "text", text: "Result recorded." }],
    isError: false,
    timestamp: 0,
  };
  for (const message of [input, reply, call, result]) {
    expect(project(message, scheduled)).toMatchObject({ display: false });
  }
  expect(Reflect.get(reply, "display")).toBeUndefined();
  for (const stopReason of ["error", "aborted"] as const) {
    const error = makeAgentAssistantMessage({
      content: [{ type: "text", text: "The check failed." }],
      stopReason,
    });
    expect(project(error, scheduled)).toBe(error);
  }
  const errorResult = { ...result, isError: true };
  expect(project(errorResult, scheduled)).toBe(errorResult);
  expect(project(reply)).toBe(reply);
});

const refresh = { kind: "internal_system", sourceTool: "progress_card_refresh" } as const;
it("hides status-only user, assistant and tool messages", () => {
  for (const role of ["user", "assistant", "toolResult"] as const) {
    const message = {
      role,
      content: [{ type: "text", text: "Refresh-only content" }],
    } as AgentMessage;
    expect(project(message, refresh)).toMatchObject({ display: false });
    expect(Reflect.get(message, "display")).toBeUndefined();
  }
});
it("hides steered refresh input using its own provenance", () => {
  const input = {
    role: "user",
    content: "Update the card",
    timestamp: 1,
    provenance: refresh,
  } as AgentMessage;
  expect(project(input)).toMatchObject({ display: false });
});
