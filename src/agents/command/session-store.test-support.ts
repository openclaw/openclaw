import path from "node:path";
import { onTestFinished } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { updateSessionStoreAfterAgentRun as updateSessionStoreAfterAgentRunBase } from "./session-store.js";

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

export async function seedSessionStore(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await patchSessionEntryCore({ storePath, sessionKey }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }
}

export function loadPersistedSessionStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

export function loadPersistedSessionEntry(
  storePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  return loadSessionEntry({ storePath, sessionKey }) ?? undefined;
}

type SessionStoreUpdateParams = Parameters<typeof updateSessionStoreAfterAgentRunBase>[0];

export async function updateSessionStoreAfterAgentRun(
  params: Omit<SessionStoreUpdateParams, "agentDir" | "agentId"> & {
    agentDir?: string;
    agentId?: string;
  },
) {
  await updateSessionStoreAfterAgentRunBase({
    ...params,
    agentId: params.agentId ?? "main",
    agentDir: params.agentDir ?? "/tmp/openclaw-session-store-test-agent",
  });
}
