import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { resolveSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { closeAuthProfileReadPool } from "./sqlite.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import { withAuthProfileStoreAgentDir } from "./store.js";
import type { OAuthCredential } from "./types.js";
import { persistAuthProfileBatch, upsertAuthProfileWithLock } from "./upsert-with-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
const profileId = "openai:scoped-owner";
const current: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-current-access",
  refresh: "synthetic-stable-refresh",
  expires: 2_000_000_000_000,
};
const refreshed: OAuthCredential = { ...current, access: "synthetic-refreshed-access" };
const unrelated: OAuthCredential = { ...current, refresh: "synthetic-unrelated-refresh" };
const mainShadow: OAuthCredential = {
  ...unrelated,
  access: "synthetic-main-shadow-access",
  expires: current.expires + 60_000,
};

afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    closeAuthProfileReadPool({ kind: "root", rootPath: stateDir });
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearAuthProfileMigrationDiagnostics();
});

const cases = (["upsert", "batch"] as const).flatMap((writer) =>
  (["scoped-runtime", "explicit-shared", "explicit-main"] as const).map((owner) => ({
    writer,
    owner,
  })),
);

describe("OAuth write observation follows the selected owner", () => {
  it.each(cases)(
    "refreshes $writer at $owner without touching the ambient owner",
    async ({ writer, owner }) => {
      const processRoot = tempDirs.make("openclaw-auth-ambient-");
      const targetRoot = tempDirs.make("openclaw-auth-target-");
      const agentDir = path.join(targetRoot, "agents", "work", "agent");
      const mainDir = path.join(targetRoot, "agents", "main", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const targetDir = owner === "scoped-runtime" && writer === "upsert" ? agentDir : undefined;
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: targetRoot, OPENCLAW_AGENT_DIR: undefined },
        async () => {
          saveAuthProfileStore(
            { version: 1, profiles: { [profileId]: current } },
            targetDir,
            saveOptions,
          );
          if (owner !== "scoped-runtime") {
            // A newer, different generation survives inherited-OAuth filtering.
            // Native local seeding must not redirect this row to the shared owner.
            saveAuthProfileStore({ version: 1, profiles: { [profileId]: mainShadow } }, mainDir, {
              ...saveOptions,
              sharedStoreWrite: false,
            });
            expect(resolveSharedAuthStoreOwnership().location).toBe("state-db");
            expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(current);
            expect(loadPersistedAuthProfileStore(mainDir)?.profiles[profileId]).toEqual(mainShadow);
          }
        },
      );
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: processRoot, OPENCLAW_AGENT_DIR: undefined },
        async () => {
          saveAuthProfileStore(
            { version: 1, profiles: { [profileId]: unrelated } },
            undefined,
            saveOptions,
          );
          const targetOptions =
            owner === "scoped-runtime"
              ? {}
              : owner === "explicit-main"
                ? { agentDir: mainDir }
                : { stateDir: targetRoot };
          const run = async () => {
            if (writer === "upsert") {
              await expect(
                upsertAuthProfileWithLock({
                  ...targetOptions,
                  profileId,
                  credential: refreshed,
                }),
              ).resolves.not.toBeNull();
            } else {
              await persistAuthProfileBatch({
                ...targetOptions,
                profiles: [{ profileId, credential: refreshed }],
              });
            }
            // Correct owner selection must not weaken generation replacement fencing.
            if (writer === "upsert") {
              await expect(
                upsertAuthProfileWithLock({
                  ...targetOptions,
                  profileId,
                  credential: unrelated,
                }),
              ).resolves.toBeNull();
            } else {
              await expect(
                persistAuthProfileBatch({
                  ...targetOptions,
                  profiles: [{ profileId, credential: unrelated }],
                }),
              ).rejects.toThrow("Refused to restore fenced OAuth refresh generation");
            }
          };
          if (owner === "scoped-runtime") {
            await withAuthProfileStoreAgentDir(agentDir, targetRoot, run);
          } else if (owner === "explicit-main") {
            await withEnvAsync(
              { OPENCLAW_STATE_DIR: targetRoot, OPENCLAW_AGENT_DIR: undefined },
              run,
            );
          } else {
            // Explicit stateDir must override this conflicting configured main directory.
            await withEnvAsync({ OPENCLAW_AGENT_DIR: mainDir }, run);
          }
          expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(unrelated);
        },
      );
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: targetRoot, OPENCLAW_AGENT_DIR: undefined },
        async () => {
          expect(loadPersistedAuthProfileStore(targetDir)?.profiles[profileId]).toEqual(refreshed);
          if (!targetDir) {
            expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
          }
          if (owner !== "scoped-runtime") {
            expect(resolveSharedAuthStoreOwnership().location).toBe("state-db");
            expect(loadPersistedAuthProfileStore(mainDir)?.profiles[profileId]).toEqual(mainShadow);
          }
        },
      );
    },
  );
});
