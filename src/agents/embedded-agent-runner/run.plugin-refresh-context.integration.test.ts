import type { Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { assembleHarnessContextEngine } from "../harness/context-engine-lifecycle.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import {
  captureEmbeddedAttemptContinuation,
  readEmbeddedContinuationPrefix,
} from "./run/attempt-continuation.js";

registerAgentSessionLoopTestLifecycle();
let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

beforeAll(async () => {
  runEmbeddedAgent = await loadSharedRunIntegrationHarness();
});
beforeEach(resetSharedRunIntegrationHarnessMocks);
afterEach(async () => state?.cleanup());

it("keeps the request and completed tool evidence through ordinary plugin refresh", async () => {
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  state = await createOpenClawTestState({ label: "plugin-refresh-context" });
  const requests: Message[][] = [];
  const reload = vi.fn(() => ({
    content: [{ type: "text" as const, text: "Plugin reloaded successfully." }],
    details: {},
  }));
  mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
    const { session } = await createTestSession({
      customTools: [
        {
          name: "reload_fixture",
          label: "Reload fixture",
          description: "Reload the fixture plugin",
          parameters: Type.Object({}),
          execute: async () => {
            params.registerPluginRuntimeRefreshConsumer?.(() => true);
            expect(captureAgentPluginRuntimeRefresh().request()).toBe(true);
            return reload();
          },
        },
      ],
    });
    const continuation = await readEmbeddedContinuationPrefix(params);
    if (continuation) {
      const assembled = await assembleHarnessContextEngine({
        contextEngine: {
          info: { id: "summary-fixture", name: "Summary fixture" },
          ingest: async () => ({ ingested: true }),
          assemble: async () => ({ messages: [], estimatedTokens: 0 }),
          compact: async () => ({ ok: true, compacted: false }),
        },
        sessionId: session.sessionId,
        agentId: "main",
        modelId: testModel.id,
        messages: session.messages,
        currentTurnMessages: continuation.currentTurnMessages,
        tokenBudget: testModel.contextWindow,
      });
      session.agent.state.messages = assembled!.messages;
    }
    session.agent.streamFn = (_model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        createAssistant(
          testModel,
          requests.length === 1
            ? [{ type: "toolCall", id: "reload", name: "reload_fixture", arguments: {} }]
            : [{ type: "text", text: "Plugin reload verified." }],
          requests.length === 1 ? "toolUse" : "stop",
        ),
      );
    };
    const capture = captureEmbeddedAttemptContinuation(params, session);
    try {
      await session.prompt(params.prompt);
    } finally {
      capture.close();
    }
    return makeAttemptResult({
      assistantTexts: ["Plugin reload verified."],
      messagesSnapshot: session.messages,
      continuationMessages: capture.read(),
    });
  });
  mockedBuildEmbeddedRunPayloads.mockImplementation(({ assistantTexts }) =>
    assistantTexts.map((text) => ({ text })),
  );
  const result = await runEmbeddedAgent({
    ...createOverflowRunParams(state),
    prompt: "Reload the plugin and verify the result.",
    agentHarnessId: "openclaw",
    provider: "fixture-provider",
    model: "fixture-model",
    sessionKey: undefined,
    config: { agents: { defaults: { experimental: { decisionAssistance: false } } } },
  });
  expect(result.meta.error).toBeUndefined();
  expect(requests).toHaveLength(3);
  expect(requests[2]).toContainEqual(
    expect.objectContaining({
      role: "toolResult",
      toolCallId: "reload",
      content: [{ type: "text", text: "Plugin reloaded successfully." }],
    }),
  );
  expect(
    requests[2]?.filter(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("Reload the plugin and verify the result."),
    ),
  ).toHaveLength(1);
  expect(reload).toHaveBeenCalledOnce();
  expect(result.payloads).toEqual([{ text: "Plugin reload verified." }]);
});
