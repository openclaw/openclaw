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

export async function cleanupRunSessionOwnersForTest({
  closeDatabases = false,
}: { closeDatabases?: boolean } = {}): Promise<void> {
  // Each test deletes its rows; the suite retains their database and filesystem owners.
  for (const owner of seededSessionOwnersForTest) {
    await deleteSessionEntry(owner);
  }
  if (closeDatabases) {
    await closeRunSessionOwnerDatabasesForTest();
  } else {
    resetPluginStateStoreForTests({ closeDatabase: false });
  }
  seededSessionOwnersForTest.length = 0;
}

export async function closeRunSessionOwnerDatabasesForTest(): Promise<void> {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}
