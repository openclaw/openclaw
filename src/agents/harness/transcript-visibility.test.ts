import { describe, expect, it, onTestFinished } from "vitest";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./transcript-visibility.js";

it("hides scheduled execution prose even without a live run registry", () => {
  const inputProvenance = { kind: "internal_system", sourceTool: "cron_execution" } as const;
  const input = { role: "user", content: "Check the queue", timestamp: 1 } as const;
  expect(
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: false,
      inputProvenance,
      message: input,
    }),
  ).toMatchObject({ display: false });
  for (const text of ["The change is ready.", "Approval is required.", "The check failed."]) {
    const message = { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
    expect(
      projectAgentHarnessTranscriptMessageForDisplay({ hidden: false, inputProvenance, message }),
    ).toMatchObject({ display: false });
  }
});

it("keeps quiet execution artifacts out of history without hiding attention or ordinary replies", () => {
  const runId = "quiet-history";
  const claim = claimAgentRunContext(
    runId,
    {
      cronRunsByJobId: new Map([["job", { nextCheckEnabled: false, assertCurrent: () => {} }]]),
    },
    { trackOwner: true, ownsContext: true },
  );
  onTestFinished(() => releaseAgentRunContext(runId, claim));
  const inputProvenance = { kind: "internal_system", sourceTool: "cron_execution" } as const;
  const project = (message: AgentMessage) =>
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: false,
      runId,
      inputProvenance,
      message,
    });
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
  // Provisional text cannot become visible before a later no_change result.
  expect(project(reply)).toMatchObject({ display: false });
  expect(project(call)).toMatchObject({ display: false });
  expect(project(result)).toMatchObject({ display: false });
  createAutomationResultRecorder(runId, "job")({ outcome: "no_change" });
  expect(project(reply)).toMatchObject({ display: false });
  expect(Reflect.get(reply, "display")).toBeUndefined();
  for (const stopReason of ["error", "aborted"] as const) {
    const error = makeAgentAssistantMessage({
      content: [{ type: "text", text: "The check failed." }],
      stopReason,
    });
    expect(project(error)).toBe(error);
  }
  const errorResult = { ...result, isError: true };
  expect(project(errorResult)).toBe(errorResult);
  expect(
    projectAgentHarnessTranscriptMessageForDisplay({ hidden: false, runId, message: reply }),
  ).toBe(reply);
});

const refresh = { kind: "internal_system", sourceTool: "progress_card_refresh" } as const;
describe("progress refresh transcript visibility", () => {
  it("hides status-only user, assistant and tool messages", () => {
    for (const role of ["user", "assistant", "toolResult"] as const) {
      const message = {
        role,
        content: [{ type: "text", text: "Refresh-only content" }],
      } as AgentMessage;
      expect(
        projectAgentHarnessTranscriptMessageForDisplay({
          hidden: false,
          inputProvenance: refresh,
          message,
        }),
      ).toMatchObject({ display: false });
      expect(Reflect.get(message, "display")).toBeUndefined();
    }
  });
  it("hides steered refresh input without hiding the active human turn's answer", () => {
    const input = {
      role: "user",
      content: "Update the card",
      timestamp: 1,
      provenance: refresh,
    } as AgentMessage;
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "The actual work is complete." }],
    } as AgentMessage;
    expect(
      projectAgentHarnessTranscriptMessageForDisplay({ hidden: false, message: input }),
    ).toMatchObject({ display: false });
    expect(projectAgentHarnessTranscriptMessageForDisplay({ hidden: false, message: answer })).toBe(
      answer,
    );
  });
});
