import path from "node:path";
import { onTestFinished } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

export async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const lifetime = createFixtureLifetime();
  onTestFinished(() => lifetime.cleanup());
  const dir = lifetime.createTempDir("openclaw-session-store-");
  try {
    return await lifetime.run(async () => {
      try {
        return await run({ dir, storePath: path.join(dir, "sessions.json") });
      } finally {
        await lifetime.verifyCleanup(async () => {
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest();
        });
      }
    });
  } finally {
    await lifetime.cleanup();
  }
}
