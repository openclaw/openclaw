import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createOverflowAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionExtension,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession compaction correlation", () => {
  it.each(["manual", "automatic"])(
    "correlates repeated %s compactions and tokens through the subscriber",
    async (mode) => {
      const runId = "run-tokens-after";
      const sessionManager = guardSessionManager(SessionManager.inMemory(), { runId });
      sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
      sessionManager.appendMessage({
        ...createAssistant(testModel, [{ type: "text", text: "retained answer" }]),
        timestamp: 2,
      });
      let requests = 0;
      streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
        createAssistantResultStream(
          ++requests % 2 === 1
            ? createOverflowAssistant(activeModel)
            : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
        ),
      );
      const { session } = await createTestSession({
        sessionManager,
        settingsManager: createAutoCompactionSettings(),
        resourceLoader: await createResourceLoader(createCompactionExtension()),
      });
      const onAgentEvent = vi.fn();
      const subscription = subscribeEmbeddedAgentSession({ session, runId, onAgentEvent });
      try {
        for (const prompt of ["first long request", "second long request"]) {
          if (mode === "manual") {
            sessionManager.appendMessage({ role: "user", content: prompt, timestamp: 3 });
            sessionManager.appendMessage(
              createAssistant(testModel, [{ type: "text", text: "answer" }]),
            );
            await session.compact();
          } else {
            await session.prompt(prompt);
          }
        }
        const compactions = sessionManager
          .getBranch()
          .filter((entry) => entry.type === "compaction");
        expect(compactions).toHaveLength(2);
        const itemIds = compactions.map(({ __openclaw: metadata }) => metadata?.itemId);
        expect(itemIds).toEqual([expect.any(String), expect.any(String)]);
        expect(new Set(itemIds).size).toBe(2);
        expect(compactions.map(({ __openclaw: metadata }) => metadata?.runId)).toEqual([
          runId,
          runId,
        ]);
        const events = onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "compaction");
        expect(events.map(({ data }) => ({ phase: data.phase, itemId: data.itemId }))).toEqual(
          itemIds.flatMap((itemId) => [
            { phase: "start", itemId },
            { phase: "end", itemId },
          ]),
        );
        expect(subscription.getCompactionCount()).toBe(2);
        expect(subscription.getLastCompactionTokensAfter()).toEqual(expect.any(Number));
        expect(subscription.getLastCompactionTokensAfter()).toBeGreaterThan(0);
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it("persists and publishes the identity a recovery caller already announced", async () => {
    const runId = "run-recovery";
    const sessionManager = guardSessionManager(SessionManager.inMemory(), { runId });
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "text", text: "retained answer" }]),
      timestamp: 2,
    });
    sessionManager.appendMessage({ role: "user", content: "next prompt", timestamp: 3 });
    sessionManager.appendMessage(createAssistant(testModel, [{ type: "text", text: "answer" }]));
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "summary" }]),
      ),
    );
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: await createResourceLoader(createCompactionExtension()),
    });
    const onAgentEvent = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({ session, runId, onAgentEvent });
    try {
      await session[agentSessionAutomaticCompaction](undefined, undefined, "none", {
        itemId: "ovf-recovery",
      });
      const compaction = sessionManager.getBranch().find((entry) => entry.type === "compaction");
      expect(compaction).toMatchObject({ __openclaw: { runId, itemId: "ovf-recovery" } });
      const events = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "compaction");
      expect(events.map(({ data }) => data.itemId)).toEqual(["ovf-recovery", "ovf-recovery"]);
    } finally {
      subscription.unsubscribe();
    }
  });
});
