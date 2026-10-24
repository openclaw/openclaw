import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createOpenClawAgentHarness } from "../../harness/builtin-openclaw.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { buildEmbeddedRunnerAssistant } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createSubscriptionMock } from "./attempt-spawn-workspace.subscription-mock.test-support.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const finalizationRunner = vi.hoisted(() => vi.fn());
vi.mock("./attempt.js", () => ({ runEmbeddedAttempt: finalizationRunner }));

const tempPaths: string[] = [];
beforeAll(preloadRunEmbeddedAttemptForTests);
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  tempPaths.length = 0;
});

describe("settled post-tool turn finalization context", () => {
  it("keeps detached tool receipts and hidden prompts across empty finalization retries", async () => {
    const { guardSessionManager } = await vi.importActual<
      typeof import("../../session-tool-result-guard-wrapper.js")
    >("../../session-tool-result-guard-wrapper.js");
    const hoisted = getHoisted();
    hoisted.guardSessionManagerMock.mockImplementation(guardSessionManager);
    const manager = SessionManager.inMemory();
    const sessionKey = "agent:main:subagent:detached-finalization";
    const toolAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }],
    });
    const toolResult = makeTextToolResult(
      "call-read",
      "read",
      "file contents from completed read",
      false,
      3,
    );
    const subscription = createSubscriptionMock();
    let toolCompleted = false;
    subscription.getItemLifecycle = () => ({
      startedCount: toolCompleted ? 1 : 0,
      completedCount: toolCompleted ? 1 : 0,
      activeCount: 0,
    });
    hoisted.subscribeEmbeddedAgentSessionMock.mockReturnValue(subscription);
    const settled = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionMessages: [],
      attemptOverrides: { sessionManager: manager, sessionPersistence: "detached" },
      sessionPrompt: async (session, prompt) => {
        const user = { role: "user" as const, content: prompt, timestamp: 1 };
        session.sessionManager!.appendMessage(user);
        session.sessionManager!.appendMessage(toolAssistant);
        session.sessionManager!.appendMessage(toolResult);
        session.messages = [...session.messages, user, toolAssistant, toolResult];
        subscription.toolMetas.push({ toolCallId: "call-read", toolName: "read", isError: false });
        toolCompleted = true;
        throw new Error("terminated");
      },
    });
    expect(settled.terminal.kind).toBe("failed");
    expect(settled.itemLifecycle).toEqual({ startedCount: 1, completedCount: 1, activeCount: 0 });
    expect(settled.settledTurnFinalizationContext).toBeDefined();
    expect(manager.buildSessionContext().messages).toContainEqual(
      expect.objectContaining(toolResult),
    );

    const finalizerContexts: unknown[][] = [];
    finalizationRunner.mockImplementation(async (attempt: EmbeddedRunAttemptParams) => {
      let finalAssistant: ReturnType<typeof buildEmbeddedRunnerAssistant> | undefined;
      const finalSubscription = createSubscriptionMock();
      finalSubscription.getCurrentAttemptAssistant = () => finalAssistant;
      hoisted.subscribeEmbeddedAgentSessionMock.mockReturnValue(finalSubscription);
      return createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey,
        tempPaths,
        attemptOverrides: Object.fromEntries(
          Object.entries(attempt).filter(([, value]) => value !== undefined),
        ),
        // The session double hydrates from the manager handed to the real runner.
        sessionMessages: attempt.sessionManager?.buildSessionContext().messages ?? [],
        sessionPrompt: async (session, prompt) => {
          finalizerContexts.push([...session.messages]);
          session.sessionManager!.appendMessage({ role: "user", content: prompt, timestamp: 4 });
          const assistant = buildEmbeddedRunnerAssistant({
            content:
              finalizerContexts.length === 1 ? [] : [{ type: "text", text: "Read completed." }],
          });
          finalAssistant = assistant;
          session.sessionManager!.appendMessage(assistant);
          session.messages = [...session.messages, assistant];
        },
      });
    });
    const admission = prepareSystemAgentRunAdmission(
      {},
      "run-settled",
      "main",
      "finalization-test",
    );
    try {
      const input = createSettledFinalizationTestInput(settled, await admission.admit("embedded"));
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
      expect(userMessages).toHaveLength(3);
      expect(userMessages[0]?.content).toBe("hello");
      expect(userMessages[0]).not.toHaveProperty("display", false);
      for (const message of userMessages.slice(1)) {
        expect(message).toMatchObject({
          content: expect.stringContaining("Your turn ended without a final reply."),
          display: false,
          provenance: { kind: "internal_system" },
        });
      }
      const genuineUser = { role: "user" as const, content: "Read the next file", timestamp: 5 };
      manager.appendMessage(genuineUser);
      expect(manager.buildSessionContext().messages).toContainEqual(
        expect.objectContaining(genuineUser),
      );
      expect(genuineUser).not.toHaveProperty("display", false);
      expect(genuineUser).not.toHaveProperty("provenance");
    } finally {
      admission.close();
    }
  });

  it.each([
    { message: "terminated", captures: true },
    { message: "the request was terminated by the server", captures: false },
  ])("captures a final provider failure '$message'=$captures", async ({ message, captures }) => {
    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:settled",
      tempPaths,
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          {
            role: "assistant",
            stopReason: "toolUse",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }],
          },
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
