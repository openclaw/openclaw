import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
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

it("does not commit a manual compaction hook that resolves after abort", async () => {
  const manager = SessionManager.inMemory();
  await manager.appendMessageAsync(makeUserMessage("old user", 1));
  await manager.appendMessageAsync({
    ...createAssistant(testModel, "old answer"),
    timestamp: 2,
  });
  await manager.appendMessageAsync(makeUserMessage("recent user", 3));
  const entered = createDeferred();
  const released = createDeferred();
  const { session } = await createTestSession({
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
      retry: { enabled: false },
    }),
    extension(api) {
      api.on("session_before_compact", async (event) => {
        entered.resolve();
        await released.promise;
        return {
          compaction: {
            summary: "late summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      });
    },
  });
  const before = manager.getPersistedEntries();
  const pending = session.compact();
  await awaitGateBeforeSettlement(
    entered.promise,
    pending,
    "manual compaction hook was not entered",
  );
  await session.abort();
  released.resolve();
  await expect(pending).rejects.toThrow(/cancel/i);
  expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
  expect(manager.getPersistedEntries()).toEqual(before);
});
