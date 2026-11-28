import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it("rejects a compaction hook boundary that is not on the current branch", async () => {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage(makeUserMessage("old user", 1));
  sessionManager.appendMessage({
    ...createAssistant(testModel, [{ type: "text", text: "old answer" }]),
    timestamp: 2,
  });
  sessionManager.appendMessage(makeUserMessage("recent user", 3));
  const { session } = await createTestSession({
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
      retry: { enabled: false },
    }),
    resourceLoader: await createResourceLoader((api) => {
      api.on("session_before_compact", async () => ({
        compaction: {
          summary: "Earlier work is summarized.",
          firstKeptEntryId: "missing-boundary-id",
          tokensBefore: 1,
        },
      }));
    }),
  });
  const before = sessionManager.buildSessionContext().messages;

  await expect(session.compact()).rejects.toThrow(/current session branch/u);

  expect(sessionManager.buildSessionContext().messages).toEqual(before);
});
