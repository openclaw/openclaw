import path from "node:path";
import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
} from "../../config/sessions/session-accessor.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";

/** Transcript fixture lifecycle for main-session-restart-recovery.test.ts only. */
export function createRestartRecoveryTranscriptFixture(
  readStore: (storePath: string) => Record<string, { sessionId: string }>,
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
    const sessionKey = Object.entries(readStore(storePath)).find(
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
        // Transcript-only cases reuse this one identity; remove every owned window.
        removals: [{ sessionKey: "agent:main:main", deleteOwnedWindows: true }],
        skipMaintenance: true,
      });
      await drainSessionStateForTest({ stateDir });
    },
  };
}
