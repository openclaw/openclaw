import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each(["", " \n\t"])(
  "rejects a session_before_compact summary of %j without replacing context",
  async (summary) => {
    const manager = SessionManager.inMemory();
    await manager.appendMessageAsync(makeUserMessage("old user", 1));
    await manager.appendMessageAsync({
      ...createAssistant(testModel, "old answer"),
      timestamp: 2,
    });
    await manager.appendMessageAsync(makeUserMessage("recent user", 3));
    const { session } = await createTestSession({
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
        retry: { enabled: false },
      }),
      extension(api) {
        api.on("session_before_compact", (event) => ({
          compaction: {
            summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
      },
    });
    const before = manager.getPersistedEntries();
    await expect(session.compact()).rejects.toThrow(/non-whitespace/i);
    expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
    expect(manager.getPersistedEntries()).toEqual(before);
  },
);
