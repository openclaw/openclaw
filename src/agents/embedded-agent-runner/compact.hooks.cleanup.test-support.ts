import { rm } from "node:fs/promises";
import * as agentDatabases from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";

export async function cleanupCompactionFixture(directory?: string): Promise<void> {
  await agentDatabases.closeOpenClawAgentDatabasesAsync();
  agentDatabases.closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  if (directory) {
    await rm(directory, { force: true, recursive: true });
  }
}
