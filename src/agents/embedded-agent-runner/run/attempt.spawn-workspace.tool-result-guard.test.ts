import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { sumToolResultTextChars } from "../tool-result-context-guard.test-support.js";
import {
  cleanupTempPaths,
  createDefaultEmbeddedSession,
  createContextEngineBootstrapAndAssemble,
  createContextEngineAttemptRunner,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const doneMessage = { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage;
const requireRecord = createRequireRecord("object", "expected-label");
type MockCallSource = { mock: { calls: ArrayLike<ReadonlyArray<unknown>> } };
function mockParams(source: MockCallSource, callIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  const value = call[0];
  if (!value) {
    throw new Error(`expected mock params: ${label}`);
  }
  return requireRecord(value, label) as Record<string, unknown>;
}
beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

describe("runEmbeddedAttempt tool-result guard budget wiring", () => {
  const sessionKey = "agent:main:guildchat:channel:tool-result-guard-budget";
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("uses the resolved contextTokenBudget before model contextWindow", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        contextTokenBudget: 1_000_000,
        model: {
          api: "openai-completions",
          provider: "openai",
          compat: {},
          contextWindow: 200_000,
          input: ["text"],
        } as never,
      },
    });

    expect(
      mockParams(hoisted.installToolResultContextGuardMock, 0, "tool-result guard params")
        .contextWindowTokens,
    ).toBe(1_000_000);
  });

  it.each([false, true])(
    "submits a persisted current turn once with context exclusion %s",
    async (excludeFromContext) => {
      const admittedMessage = {
        role: "user" as const,
        content: "durable current turn",
        idempotencyKey: "restart-safe-run:user",
        ...(excludeFromContext ? { excludeFromContext: true as const } : {}),
        timestamp: 1,
        __openclaw: { senderId: "alice-id", senderName: "Alice" },
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: admittedMessage,
        target: () => undefined,
      });
      recorder.markRuntimePersisted(admittedMessage);
      if (excludeFromContext) {
        hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
          id: "speech",
          parentId: "previous-assistant",
          type: "message",
          message: { role: "user", content: "spoken predecessor", timestamp: 0 },
        });
      }
      let submittedMessages: AgentMessage[] = [];
      const initialMessages = excludeFromContext ? [] : [admittedMessage];

      const result = await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey,
        tempPaths,
        sessionMessages: initialMessages,
        attemptOverrides: {
          prompt: admittedMessage.content,
          transcriptPrompt: admittedMessage.content,
          suppressNextUserMessagePersistence: true,
          userTurnTranscriptRecorder: recorder,
        },
        createSession: () => {
          const session = createDefaultEmbeddedSession({ initialMessages });
          session.agent.convertToLlm = vi.fn(async (messages) => messages as never);
          const baseStreamFn = session.agent.streamFn;
          session.agent.streamFn = async (...args) => {
            const context = args[1] as { messages?: AgentMessage[] } | undefined;
            submittedMessages =
              ((await session.agent.convertToLlm?.(context?.messages ?? [])) as AgentMessage[]) ??
              [];
            return await baseStreamFn?.(...args);
          };
          session.prompt = async (prompt, options) => {
            session.messages = [
              ...session.messages,
              {
                role: "user",
                content: prompt,
                idempotencyKey: admittedMessage.idempotencyKey,
                timestamp: admittedMessage.timestamp,
              },
            ];
            options?.preflightResult?.(true);
            await session.agent.streamFn?.(
              {} as never,
              { messages: session.messages } as never,
              {} as never,
            );
            session.messages = [...session.messages, doneMessage];
          };
          return session;
        },
      });

      expect(result.finalPromptText).toBe(admittedMessage.content);
      expect(result.messagesSnapshot).toContainEqual(doneMessage);
      expect(submittedMessages.filter((message) => message.role === "user")).toEqual([
        expect.objectContaining({
          content: expect.stringContaining('"name":"Alice"'),
          role: "user",
        }),
      ]);
    },
  );

  it("passes context engines the message budget after reserve and rendered prompt pressure", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    hoisted.compactionReserveTokens = 20_000;

    await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      attemptOverrides: {
        contextTokenBudget: 100_000,
        prompt: "current prompt",
        transcriptPrompt: "current prompt",
      },
    });

    const assembleParams = mockParams(
      contextEngine.assemble as MockCallSource,
      0,
      "assemble params",
    );
    expect(assembleParams.tokenBudget).toBeLessThan(80_000);
    expect(assembleParams.runtimeSettings).toMatchObject({
      limits: {
        maxOutputTokens: 20_000,
      },
    });
  });

  it("preserves the cacheable prefix while bounding current prompt results", async () => {
    const toolText = "process output ".repeat(70);
    const sessionMessages: AgentMessage[] = [{ role: "user", content: "seed", timestamp: 1 }];
    for (let index = 0; index < 8; index += 1) {
      const toolCallId = `call_${index}`;
      sessionMessages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "process", input: {} }],
        timestamp: 2 + index * 2,
      } as unknown as AgentMessage);
      sessionMessages.push({
        role: "toolResult",
        toolCallId,
        toolName: "process",
        content: [{ type: "text", text: `${index}: ${toolText}` }],
        isError: false,
        timestamp: 3 + index * 2,
      } as AgentMessage);
    }
    let submittedMessages: AgentMessage[] = [];
    let promptHandlerMessages: AgentMessage[] = [];
    let afterTurnMessages: AgentMessage[] = [];
    const afterTurn = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => {
      afterTurnMessages = messages;
    });

    await createContextEngineAttemptRunner({
      contextEngine: {
        ...createContextEngineBootstrapAndAssemble(),
        afterTurn,
      },
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: { contextTokenBudget: 128_000 },
      createSession: () => {
        const session = createDefaultEmbeddedSession({ initialMessages: sessionMessages });
        session.agent.streamFn = async (_model, context) => {
          const providerMessages = (context as { messages?: AgentMessage[] } | undefined)?.messages;
          submittedMessages = providerMessages ?? [];
          return {
            async result() {
              return doneMessage;
            },
            [Symbol.asyncIterator]() {
              return (async function* () {})();
            },
          };
        };
        session.prompt = async (_prompt, options) => {
          for (let index = 0; index < 8; index += 1) {
            session.messages.push({
              role: "toolResult",
              toolCallId: `current_call_${index}`,
              toolName: "process",
              content: [
                { type: "text", text: `current ${index}: ${"current output ".repeat(3_000)}` },
              ],
              isError: false,
              timestamp: 100 + index,
            } as AgentMessage);
          }
          promptHandlerMessages = session.messages.map((message) => message as AgentMessage);
          options?.preflightResult?.(true);
          await session.agent.streamFn?.({} as never, { messages: session.messages } as never, {});
          session.messages = [...session.messages, doneMessage];
        };
        return session;
      },
    });

    expect(sumToolResultTextChars(sessionMessages)).toBeGreaterThan(4_000);
    expect(sumToolResultTextChars(promptHandlerMessages)).toBeGreaterThan(4_000);
    const submittedCurrentPromptMessages = submittedMessages.slice(sessionMessages.length);
    expect(
      submittedMessages
        .filter((message) => message.role === "toolResult")
        .every((message) => sumToolResultTextChars([message]) <= 32_000),
    ).toBe(true);
    expect(JSON.stringify(submittedCurrentPromptMessages)).toContain("truncated");
    expect(afterTurn).toHaveBeenCalledTimes(1);
    expect(sumToolResultTextChars(afterTurnMessages)).toBeGreaterThan(4_000);
    expect(JSON.stringify(afterTurnMessages)).not.toContain("truncated");
  });

  it("submits aggregate prompt-history pressure to the provider before recovery", async () => {
    let sawPrompt = false;
    const sessionMessages: AgentMessage[] = [{ role: "user", content: "seed", timestamp: 1 }];
    for (let index = 0; index < 5; index += 1) {
      sessionMessages.push({
        ...makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: `aggregate_${index}`, name: "read", arguments: {} }],
          timestamp: 2 + index * 2,
        }),
      });
      sessionMessages.push({
        role: "toolResult",
        toolCallId: `aggregate_${index}`,
        toolName: "read",
        content: [{ type: "text", text: `${index}: ${"aggregate output ".repeat(900)}` }],
        isError: false,
        timestamp: 3 + index * 2,
      } as AgentMessage);
    }
    sessionMessages.push(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "old turn done" }],
        timestamp: 20,
      }),
    );

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        contextTokenBudget: 1_000,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [...session.messages, doneMessage];
      },
    });

    expect(sawPrompt).toBe(true);
    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(projectAgentRunAttemptTerminal(result.terminal).promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(1);
  });

  it("submits protected trailing aggregate pressure to the provider before recovery", async () => {
    let sawPrompt = false;
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "seed", timestamp: 1 },
      makeAgentAssistantMessage({
        content: Array.from({ length: 5 }, (_, index) => ({
          type: "toolCall",
          id: `fresh_${index}`,
          name: "read",
          arguments: {},
        })),
        timestamp: 2,
      }),
    ];
    for (let index = 0; index < 5; index += 1) {
      sessionMessages.push({
        role: "toolResult",
        toolCallId: `fresh_${index}`,
        toolName: "read",
        content: [{ type: "text", text: `${index}: ${"fresh output ".repeat(90)}` }],
        isError: false,
        timestamp: 3 + index,
      } as AgentMessage);
    }

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        contextTokenBudget: 1_000,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [...session.messages, doneMessage];
      },
    });

    expect(sawPrompt).toBe(true);
    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(projectAgentRunAttemptTerminal(result.terminal).promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(1);
  });
});
