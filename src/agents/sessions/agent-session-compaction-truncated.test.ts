import { describe, expect, it } from "vitest";
import {
  appendHistory,
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession truncated compaction", () => {
  it.each([
    { kind: "history", keepRecentTokens: 4, label: "Summarization" },
    { kind: "turn-prefix", keepRecentTokens: 1, label: "Turn prefix summarization" },
  ])(
    "keeps history unchanged after a truncated $kind summary",
    async ({ keepRecentTokens, label }) => {
      const sessionManager = SessionManager.inMemory();
      await appendHistory(
        sessionManager,
        createAssistant(testModel, [{ type: "text", text: "historical answer to preserve" }]),
      );
      if (keepRecentTokens === 4) {
        await sessionManager.appendMessageAsync({ role: "user", content: "new", timestamp: 3 });
        await sessionManager.appendMessageAsync(
          createAssistant(testModel, [{ type: "text", text: "new reply" }]),
        );
      }
      streamMocks.streamSimple.mockImplementation((model) =>
        createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "## Next Steps: unfinished" }], "length"),
        ),
      );
      const { session } = await createTestSession({
        sessionManager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true, reserveTokens: 0, keepRecentTokens },
          retry: { enabled: false },
        }),
        resourceLoader: createResourceLoader(),
      });
      const entries = sessionManager.getEntries();
      const messages = [...session.messages];
      const leaf = sessionManager.getLeafId();

      await expect(session.compact()).rejects.toThrow(
        label + " failed: summary truncated at the output token limit",
      );

      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      expect(sessionManager.getEntries()).toEqual(entries);
      expect(sessionManager.getLeafId()).toBe(leaf);
      expect(session.messages).toEqual(messages);
    },
  );
});
