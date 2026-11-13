import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import safeguard from "../agent-hooks/compaction-safeguard.js";
import { compactionSettings } from "./agent-session-boundary.test-support.js";
import {
  createAssistant,
  holdAssistantResponse,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each(["core", "safeguard"] as const)(
  "attributes concurrent %s summaries to their owning sessions",
  async (mode) => {
    const sessions = await Promise.all(
      ["history-a", "history-b"].map(async (history) => {
        const sessionManager = SessionManager.inMemory();
        await sessionManager.appendMessageAsync({ role: "user", content: history, timestamp: 1 });
        await sessionManager.appendMessageAsync(createAssistant(testModel, "Earlier answer"));
        await sessionManager.appendMessageAsync({
          role: "user",
          content: "Continue",
          timestamp: 3,
        });
        if (mode === "safeguard") {
          setCompactionSafeguardRuntime(sessionManager, {
            model: testModel,
            recentTurnsPreserve: 0,
            qualityGuardEnabled: false,
          });
        }
        const { session } = await createTestSession({
          sessionManager,
          settingsManager: compactionSettings({ reserveTokens: 128 }),
          extension: mode === "safeguard" ? safeguard : undefined,
        });
        return { history, session, sessionManager };
      }),
    );
    const entered = createDeferred();
    const release = createDeferred();
    const requests: Array<{ prompt: string; sessionId?: string }> = [];
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, context: Context, options?: SimpleStreamOptions) => {
        requests.push({ prompt: JSON.stringify(context.messages), sessionId: options?.sessionId });
        if (requests.length === 2) {
          entered.resolve();
        }
        const held = holdAssistantResponse(() =>
          createAssistant(activeModel, "Summary of earlier history."),
        );
        void release.promise.then(() => held.release());
        return held.response;
      },
    );
    const compactions = Promise.all(sessions.map(({ session }) => session.compact()));
    try {
      await entered.promise;
      expect(requests).toHaveLength(2);
      for (const { history, session } of sessions) {
        expect(requests.find(({ prompt }) => prompt.includes(history))?.sessionId).toBe(
          session.sessionId,
        );
      }
    } finally {
      release.resolve();
      await compactions;
      sessions.forEach(({ sessionManager }) => setCompactionSafeguardRuntime(sessionManager, null));
    }
  },
);
