import path from "node:path";
import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  replaceSessionEntry,
  applySessionEntryLifecycleMutation,
} from "../../config/sessions/session-accessor.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";
import {
  createSessionEntry,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";

/** Default-main transcript fixture lifecycle for restart recovery tests. */
export function createRestartRecoveryTranscriptFixture(
  readFixtureStore: (storePath: string) => Record<string, { sessionId: string }>,
) {
  let preparedRoot: string | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      if (preparedRoot) {
        await cleanupSessionStateForTest({ stateDir: preparedRoot });
      }
      cleanup();
    }),
  );

  async function writeTranscript(
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ): Promise<void> {
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = Object.entries(readFixtureStore(storePath)).find(
      ([, entry]) => entry.sessionId === sessionId,
    )?.[0];
    if (!sessionKey) {
      throw new Error(`expected session entry for transcript fixture: ${sessionId}`);
    }
    for (const message of messages) {
      await appendTranscriptMessage(
        { sessionId, sessionKey, storePath },
        {
          cwd: sessionsDir,
          message,
        },
      );
    }
  }

  return {
    writeTranscript,
    prepareRoot: (): string =>
      (preparedRoot ??= tempDirs.make("openclaw-recovery-transcript-fixture-")),
    reset: async (stateDir: string): Promise<void> => {
      if (stateDir !== preparedRoot) {
        return;
      }
      await drainSessionStateForTest({ stateDir });
      await applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
        // These cases reuse this one identity; remove every owned window.
        removals: [{ sessionKey: "agent:main:main", deleteOwnedWindows: true }],
        skipMaintenance: true,
      });
      await drainSessionStateForTest({ stateDir });
    },
  };
}

export async function writeStorePath(
  storePath: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await Promise.all(
    Object.entries(store).map(([sessionKey, entry]) =>
      replaceSessionEntry({ storePath, sessionKey }, createSessionEntry(entry)),
    ),
  );
}

export async function writeStore(
  sessionsDir: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await writeStorePath(path.join(sessionsDir, "sessions.json"), store);
}

export function runningSessionEntry(
  sessionId: string,
  overrides: SessionEntryFixture = {},
): SessionEntry {
  return createSessionEntry({
    sessionId,
    updatedAt: Date.now() - 10_000,
    status: "running",
    ...overrides,
  });
}

export function readStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}
