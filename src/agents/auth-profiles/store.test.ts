import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

async function writeAuthStore(agentDir: string, store: AuthProfileStore) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  await fs.writeFile(authPath, JSON.stringify(store), "utf-8");
}

describe("updateAuthProfileStoreWithLock", () => {
  afterEach(() => clearRuntimeAuthProfileStoreSnapshots());

  it("syncs updated usageStats back to runtime snapshot", async () => {
    await withStateDirEnv("openclaw-store-sync-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });

      const initial: AuthProfileStore = {
        version: 1,
        profiles: {
          "google:key-1": { type: "api_key", provider: "google", key: "sk-1" },
          "google:key-2": { type: "api_key", provider: "google", key: "sk-2" },
        },
      };
      await writeAuthStore(agentDir, initial);

      // Populate runtime snapshot (simulates gateway startup)
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: initial }]);

      // Verify snapshot has no usageStats initially
      const before = ensureAuthProfileStore(agentDir);
      expect(before.usageStats?.["google:key-1"]?.lastUsed).toBeUndefined();

      // Update via lock (simulates markAuthProfileUsed after run completion)
      await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.usageStats = store.usageStats ?? {};
          store.usageStats["google:key-1"] = { lastUsed: 1000 };
          return true;
        },
      });

      // Subsequent snapshot read should see the updated lastUsed
      const after = ensureAuthProfileStore(agentDir);
      expect(after.usageStats?.["google:key-1"]?.lastUsed).toBe(1000);
      expect(after.usageStats?.["google:key-2"]).toBeUndefined();
    });
  });
});
