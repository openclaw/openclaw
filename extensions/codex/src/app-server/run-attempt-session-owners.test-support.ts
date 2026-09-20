import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  deleteSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";

const seededSessionOwnersForTest: Array<Parameters<typeof deleteSessionEntry>[0]> = [];

/** Models the core owner required for a reusable stable-key Codex binding. */
export async function seedRunSessionOwnerForTest(sessionId: string, sessionKey: string) {
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: resolveStorePath(undefined, { agentId: "main" }),
    env: { ...process.env },
  };
  await upsertSessionEntry({ ...scope, entry: { sessionId, updatedAt: Date.now() } });
  seededSessionOwnersForTest.push({ ...scope, expectedSessionId: sessionId });
}

export async function cleanupRunSessionOwnersForTest(): Promise<void> {
  // Seeded rows retain their original selectors until their maintenance owners settle.
  for (const owner of seededSessionOwnersForTest) {
    await deleteSessionEntry(owner);
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  seededSessionOwnersForTest.length = 0;
}
