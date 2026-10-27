import { describe, expect, it, vi } from "vitest";
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

describe("settled post-tool turn finalization context", () => {
  it("keeps detached tool receipts and hidden prompts across empty finalization retries", async () => {
    const { guardSessionManager } = await vi.importActual<
      typeof import("../../session-tool-result-guard-wrapper.js")
    >("../../session-tool-result-guard-wrapper.js");
    hoisted.guardSessionManagerMock.mockImplementation(guardSessionManager);
    const manager = SessionManager.inMemory();
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
      sessionMessages: [],
      attemptOverrides: { sessionManager: manager, sessionPersistence: "detached" },
      sessionPrompt: async (session, prompt) => {
        const user = { role: "user" as const, content: prompt, timestamp: 1 };
        for (const message of [user, call, toolResult]) {
          session.sessionManager!.appendMessage(message);
        }
        session.messages = [...session.messages, user, call, toolResult];
        subscription.toolMetas.push({ toolCallId: "call-read", toolName: "read", isError: false });
        toolCompleted = true;
        throw new Error("terminated");
      },
    });
    expect(settled.terminal.kind).toBe("failed");
    expect(settled.itemLifecycle).toEqual({ startedCount: 1, completedCount: 1, activeCount: 0 });

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
          const assistant = textAssistant(
            finalizerContexts.length === 1 ? undefined : "Read completed.",
          );
          finalAssistant = assistant;
          session.sessionManager!.appendMessage(assistant);
          session.messages = [...session.messages, assistant];
        },
      });
    });
    const input = createSettledFinalizationTestInput(settled, getContext());
    input.finalization.preparedAttempt = {
      ...input.finalization.preparedAttempt,
      sessionManager: manager,
      sessionPersistence: "detached",
      sessionKey,
      provider: "openai",
      modelId: "gpt-test",
    };
    input.finalization.harness = createOpenClawAgentHarness();
    const result = await prepareTerminalWithSettledTurnFinalization(input);
    expect(result.finalizationOutcome).toBe("answered");
    expect(finalizerContexts).toHaveLength(2);
    for (const messages of finalizerContexts) {
      expect(messages).toContainEqual(expect.objectContaining(toolResult));
    }
    const userMessages = manager
      .buildSessionContext()
      .messages.filter((message) => message.role === "user");
    const internalPrompt = {
      content: expect.stringContaining("Your turn ended without a final reply."),
      display: false,
      provenance: { kind: "internal_system" },
    };
    expect(userMessages).toMatchObject([{ content: "hello" }, internalPrompt, internalPrompt]);
    expect(userMessages[0]).not.toHaveProperty("display", false);
    const genuineUser = { role: "user" as const, content: "Read the next file", timestamp: 5 };
    manager.appendMessage(genuineUser);
    expect(manager.buildSessionContext().messages).toContainEqual(
      expect.objectContaining(genuineUser),
    );
    expect(genuineUser).not.toHaveProperty("display", false);
    expect(genuineUser).not.toHaveProperty("provenance");
  });

  it.each([
    { message: "terminated", captures: true },
    { message: "the request was terminated by the server", captures: false },
  ])("captures a final provider failure '$message'=$captures", async ({ message, captures }) => {
    const result = await runAttempt({
      sessionKey: "agent:main:telegram:direct:settled",
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { ...toolAssistant(["call-read", "read"]), timestamp: 2 },
          makeTextToolResult("call-read", "read", "file contents", false, 3),
        ];
        throw new Error(message);
      },
    });
    expect(result.terminal.kind).toBe("failed");
    expect(result.assistantTexts.every((text) => !text.trim())).toBe(true);
    const context = result.settledTurnFinalizationContext;
    if (!captures) {
      expect(context).toBeUndefined();
      return;
    }
    if (context?.source !== "openclaw-transcript") {
      throw new Error("Expected the built-in settled transcript context");
    }
    expect(context.messages.some((entry) => entry.role === "toolResult")).toBe(true);
    expect(Object.isFrozen(context.messages)).toBe(true);
  });
});
