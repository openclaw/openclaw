import path from "node:path";
import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
} from "../../config/sessions/session-accessor.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";

/** Database lifecycle for main-session-recovery-store.test.ts only. */
export function createMainSessionRecoveryStoreFixture() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      for (const stateDir of tempDirs.dirs) {
        await cleanupSessionStateForTest({ stateDir });
      }
      cleanup();
    }),
  );
  const stores = new Map<string, string>();
  let isolatedStoreDir: string | undefined;

  return {
    fixtureStore: (agentId = "main"): string => {
      let fixturePath = stores.get(agentId);
      if (!fixturePath) {
        fixturePath = path.join(tempDirs.make("openclaw-main-recovery-store-"), "sessions.json");
        stores.set(agentId, fixturePath);
      }
      return fixturePath;
    },
    createMovedSessionStore: (): string => {
      isolatedStoreDir = tempDirs.make("openclaw-main-recovery-moved-store-");
      return path.join(isolatedStoreDir, "sessions.json");
    },
    resetCase: async (): Promise<void> => {
      if (isolatedStoreDir) {
        // Moved-window layouts are recovery inputs, not canonical cleanup projections.
        await cleanupSessionStateForTest({ stateDir: isolatedStoreDir });
        isolatedStoreDir = undefined;
      }
      for (const [agentId, storePath] of stores) {
        const stateDir = path.dirname(storePath);
        await drainSessionStateForTest({ stateDir });
        await applySessionEntryLifecycleMutation({
          agentId,
          storePath,
          // Reused IDs need their physical windows removed, not retained alias nodes.
          removals: listSessionEntriesCore({ agentId, storePath }).map(({ sessionKey }) => ({
            sessionKey,
            deleteOwnedWindows: true,
          })),
          skipMaintenance: true,
        });
        await drainSessionStateForTest({ stateDir });
      }
    },
  };
}
