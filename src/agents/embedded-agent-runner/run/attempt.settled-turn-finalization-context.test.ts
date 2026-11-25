import { expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createOpenClawAgentHarness } from "../../harness/builtin-openclaw.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
import { createSubscriptionMock } from "./attempt-spawn-workspace.subscription-mock.test-support.js";
import { useFinalizationAdmission } from "./settled-finalization-harness.test-support.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { textAssistant, toolAssistant } from "./settled-turn-fixtures.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const finalizationRunner = vi.hoisted(() => vi.fn());
vi.mock("./attempt.js", () => ({ runEmbeddedAttempt: finalizationRunner }));

const sessionKey = "agent:main:subagent:detached-finalization";
const { hoisted, runAttempt } = useContextEngineAttemptHarness(sessionKey);
const getContext = useFinalizationAdmission([]);

it.each([
  { message: "terminated", captures: true },
  { message: "the request was terminated by the server", captures: false },
])(
  "preserves assembled finalization context for '$message'=$captures",
  async ({ message: failureMessage, captures }) => {
    const { guardSessionManager } = await vi.importActual<
      typeof import("../../session-tool-result-guard-wrapper.js")
    >("../../session-tool-result-guard-wrapper.js");
    hoisted.guardSessionManagerMock.mockImplementation(guardSessionManager);
    const manager = SessionManager.inMemory();
    const rawHistory = { role: "user" as const, content: "omitted history", timestamp: 0 };
    const historicalAnswer = textAssistant("Earlier answer.");
    manager.appendMessage(rawHistory);
    manager.appendMessage(historicalAnswer);
    const call = toolAssistant(["call-read", "read"]);
    const toolResult = makeTextToolResult("call-read", "read", "file contents", false, 3);
    const subscription = createSubscriptionMock();
    let toolCompleted = false;
    subscription.getItemLifecycle = () => ({
      startedCount: toolCompleted ? 1 : 0,
      completedCount: toolCompleted ? 1 : 0,
      activeCount: 0,
    });
    hoisted.subscribeEmbeddedAgentSessionMock.mockReturnValue(subscription);
    const settled = await runAttempt({
      sessionMessages: [rawHistory, historicalAnswer],
      contextEngine: {
        assemble: async ({ messages }) => ({
          messages: messages.filter(
            (message) => message.role !== "user" || message.content !== rawHistory.content,
          ),
          estimatedTokens: 1,
        }),
      },
      attemptOverrides: { sessionManager: manager, sessionPersistence: "detached" },
      sessionPrompt: async (session, prompt) => {
        const user = { role: "user" as const, content: prompt, timestamp: 1 };
        for (const message of [user, call, toolResult]) {
          session.sessionManager!.appendMessage(message);
        }
        session.messages = [...session.messages, user, call, toolResult];
        subscription.toolMetas.push({ toolCallId: "call-read", toolName: "read", isError: false });
        toolCompleted = true;
        throw new Error(failureMessage);
      },
    });
    expect(settled.terminal.kind).toBe("failed");
    expect(settled.itemLifecycle).toEqual({ startedCount: 1, completedCount: 1, activeCount: 0 });
    expect(settled.assistantTexts.every((text) => !text.trim())).toBe(true);
    const context = settled.settledTurnFinalizationContext;
    if (!captures) {
      expect(context).toBeUndefined();
      return;
    }
    if (context?.source !== "openclaw-transcript") {
      throw new Error("Expected the built-in settled transcript context");
    }
    expect(Object.isFrozen(context.messages)).toBe(true);

    const finalizerContexts: unknown[][] = [];
    finalizationRunner.mockImplementation(async (attempt: EmbeddedRunAttemptParams) => {
      let finalAssistant: ReturnType<typeof textAssistant> | undefined;
      const finalSubscription = createSubscriptionMock();
      finalSubscription.getCurrentAttemptAssistant = () => finalAssistant;
      hoisted.subscribeEmbeddedAgentSessionMock.mockReturnValue(finalSubscription);
      return runAttempt({
        attemptOverrides: Object.fromEntries(
          Object.entries(attempt).filter(([, value]) => value !== undefined),
        ),
        // The session double hydrates from the manager handed to the real runner.
        sessionMessages: attempt.sessionManager?.buildSessionContext().messages ?? [],
        sessionPrompt: async (session, prompt) => {
          finalizerContexts.push([...session.messages]);
          session.sessionManager!.appendMessage({ role: "user", content: prompt, timestamp: 4 });
          finalAssistant = textAssistant(
            finalizerContexts.length === 1 ? undefined : "Read completed.",
          );
          session.sessionManager!.appendMessage(finalAssistant);
          session.messages = [...session.messages, finalAssistant];
        },
      });
    });
    const input = createSettledFinalizationTestInput(settled, getContext());
    Object.assign(input.finalization.preparedAttempt, {
      sessionManager: manager,
      sessionPersistence: "detached",
      sessionKey,
      provider: "openai",
      modelId: "gpt-test",
    });
    input.finalization.harness = createOpenClawAgentHarness();
    const result = await prepareTerminalWithSettledTurnFinalization(input);
    expect(result.finalizationOutcome).toBe("answered");
    expect(finalizerContexts).toHaveLength(2);
    for (const messages of finalizerContexts) {
      expect(messages).toContainEqual(expect.objectContaining(toolResult));
      expect(messages).not.toContainEqual(expect.objectContaining(rawHistory));
    }
    const users = manager.buildSessionContext().messages.filter(({ role }) => role === "user");
    const hiddenPrompt = {
      content: expect.stringContaining("Your turn ended without a final reply."),
      display: false,
      provenance: { kind: "internal_system" },
    };
    expect(users).toMatchObject([rawHistory, { content: "hello" }, hiddenPrompt, hiddenPrompt]);
    expect(users[1]).not.toHaveProperty("display", false);
    const genuineUser = { role: "user" as const, content: "Read the next file", timestamp: 5 };
    manager.appendMessage(genuineUser);
    expect(manager.buildSessionContext().messages).toContainEqual(
      expect.objectContaining(genuineUser),
    );
    expect(genuineUser).not.toHaveProperty("display", false);
    expect(genuineUser).not.toHaveProperty("provenance");
  },
);
