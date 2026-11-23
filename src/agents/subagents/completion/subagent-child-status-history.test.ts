import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { Message } from "../../../llm/types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { sanitizeToolUseResultPairingForModel } from "../../session-transcript-repair.js";
import { convertToLlm } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { appendChildStatusToRequester } from "./subagent-completion-admission.store.js";

type RequesterScope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };

async function seedRequester(state: { statePath(name: string): string }): Promise<RequesterScope> {
  const scope = {
    agentId: "main",
    sessionId: "parent",
    sessionKey: "agent:main:parent",
    storePath: state.statePath("transcript.sqlite"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return scope;
}

function failedChild(scope: RequesterScope) {
  return createSubagentRunRecord({
    runId: "child-run",
    label: "Fix the parser",
    childSessionKey: "agent:main:subagent:parser",
    requesterSessionKey: scope.sessionKey,
    requesterAgentId: scope.agentId,
    requesterStorePath: scope.storePath,
    expectsCompletionMessage: true,
    startedAt: 1,
    endedAt: 2,
    outcome: { status: "error", error: "provider timeout" },
  });
}

const statusTexts = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === "user" &&
    typeof message.content !== "string" &&
    message.content.some((block) => block.type === "text" && block.text.includes("Fix the parser"))
      ? [message]
      : [],
  );

it("appends a failed child's status once to an idle parent and keeps it after compaction", () =>
  withOpenClawTestState({ label: "child-status-idle" }, async (state) => {
    const scope = await seedRequester(state);
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync({ role: "user", content: "Start a child", timestamp: 1 });
    const answer = makeAgentAssistantMessage({ content: [{ type: "text", text: "Started." }] });
    const answerId = await manager.appendMessageAsync(answer);

    const child = failedChild(scope);
    await appendChildStatusToRequester([child]);
    await appendChildStatusToRequester([child]);

    const context = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();
    const llm = convertToLlm(context.messages);
    const [status] = statusTexts(llm);
    expect(statusTexts(llm)).toHaveLength(1);
    expect(llm.at(-1)).toBe(status);
    const text = JSON.stringify(status?.content);
    expect(text).toContain("failed: provider timeout");
    expect(text).toContain("sessions_spawn");

    const next = { role: "user" as const, content: "Any news?", timestamp: 3 };
    const reopened = await SessionManager.openAsync(scope);
    await reopened.appendMessageAsync(next);
    await reopened.appendCompactionAsync("Earlier conversation", answerId!, 100);
    const compacted = convertToLlm(
      (await SessionManager.openModelContextAsync(scope)).buildSessionContext().messages,
    );
    expect(statusTexts(compacted)).toHaveLength(1);
  }));

it("bounds a large failed cohort to one shared history budget", () =>
  withOpenClawTestState({ label: "child-status-budget" }, async (state) => {
    const scope = await seedRequester(state);
    await SessionManager.openAsync(scope);
    const cohort = Array.from({ length: 16 }, (_, index) =>
      createSubagentRunRecord({
        runId: `cohort-${index}`,
        label: `Fix the parser ${index}`,
        childSessionKey: `agent:main:subagent:cohort-${index}`,
        requesterSessionKey: scope.sessionKey,
        requesterAgentId: scope.agentId,
        requesterStorePath: scope.storePath,
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "x".repeat(20_000) },
        startedAt: 1,
        endedAt: 2,
        outcome: { status: "error", error: "e".repeat(5_000) },
      }),
    );
    await appendChildStatusToRequester(cohort);

    const statuses = statusTexts(
      convertToLlm(
        (await SessionManager.openModelContextAsync(scope)).buildSessionContext().messages,
      ),
    );
    expect(statuses).toHaveLength(1);
    const content = statuses[0]?.content;
    const text =
      typeof content === "string"
        ? content
        : (content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text.length).toBeLessThanOrEqual(32_000);
    expect(text).toContain("Result truncated");
  }));

it("keeps tool call and result adjacent at the provider boundary when a child ends mid-turn", () =>
  withOpenClawTestState({ label: "child-status-mid-turn" }, async (state) => {
    const scope = await seedRequester(state);
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync({ role: "user", content: "Run it", timestamp: 1 });
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
        stopReason: "toolUse",
      }),
    );

    await appendChildStatusToRequester([failedChild(scope)]);

    await manager.appendMessageAsync({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 2,
    });
    // The status lands between the call and its result; replay pairing moves it after the result.
    const llm = convertToLlm(
      sanitizeToolUseResultPairingForModel(
        (await SessionManager.openModelContextAsync(scope)).buildSessionContext().messages,
        false,
      ),
    );
    const callIndex = llm.findIndex(
      (message) =>
        message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
    );
    expect(llm[callIndex + 1]?.role).toBe("toolResult");
    expect(statusTexts(llm)).toHaveLength(1);
    expect(llm[callIndex + 2]).toBe(statusTexts(llm)[0]);
  }));
