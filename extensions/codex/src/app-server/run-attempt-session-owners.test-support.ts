import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  deleteSessionEntry,
  patchSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  withSessionHistoryBudgetSweepsForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";

const seededSessionOwnersForTest: Array<Parameters<typeof deleteSessionEntry>[0]> = [];

/** Models the core owner required for a reusable stable-key Codex binding. */
export async function seedRunSessionOwnerForTest(
  sessionId: string,
  sessionKey: string,
  options: { lifecycleRevision?: string } = {},
) {
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: resolveStorePath(undefined, { agentId: "main" }),
    env: { ...process.env },
  };
  await withSessionHistoryBudgetSweepsForTest(async () => {
    const entry = { sessionId, updatedAt: Date.now(), ...options };
    await patchSessionEntry({
      ...scope,
      fallbackEntry: entry,
      replaceEntry: true,
      // Synthetic owners must not start logical maintenance in later fake-clock windows.
      skipMaintenance: true,
      update: () => entry,
    });
    seededSessionOwnersForTest.push({ ...scope, expectedSessionId: sessionId });
  });
}

export async function cleanupRunSessionOwnersForTest({
  closeDatabases = false,
}: { closeDatabases?: boolean } = {}): Promise<void> {
  // Each test deletes its rows; the suite retains their database and filesystem owners.
  await withSessionHistoryBudgetSweepsForTest(async () => {
    for (const owner of seededSessionOwnersForTest) {
      await deleteSessionEntry(owner);
    }
  });
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
