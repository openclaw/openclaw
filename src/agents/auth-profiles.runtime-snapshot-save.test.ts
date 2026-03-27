import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { ensureAuthProfileStore, markAuthProfileUsed } from "./auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "./auth-profiles/store.js";

describe("auth profile runtime snapshot persistence", () => {
  it("does not write resolved plaintext keys during usage updates", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-runtime-save-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: { OPENAI_API_KEY: "sk-runtime-openai" }, // pragma: allowlist secret
        agentDirs: [agentDir],
      });
      activateSecretsRuntimeSnapshot(snapshot);

      const runtimeStore = ensureAuthProfileStore(agentDir);
      expect(runtimeStore.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        key: "sk-runtime-openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      });

      await markAuthProfileUsed({
        store: runtimeStore,
        profileId: "openai:default",
        agentDir,
      });

      const persisted = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        profiles: Record<string, { key?: string; keyRef?: unknown }>;
      };
      expect(persisted.profiles["openai:default"]?.key).toBeUndefined();
      expect(persisted.profiles["openai:default"]?.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      });
    } finally {
      clearSecretsRuntimeSnapshot();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("updateAuthProfileStoreWithLock updates runtime cache after save (#55562)", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-cache-update-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "sk-disk-key",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: {},
        agentDirs: [agentDir],
      });
      activateSecretsRuntimeSnapshot(snapshot);

      // Runtime cache should have the disk profile
      const before = ensureAuthProfileStore(agentDir);
      expect(before.profiles["openai:default"]?.provider).toBe("openai");

      // Mutate via locked updater (adds usageStats)
      await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.usageStats = { "openai:default": { lastUsed: 123 } };
          return true;
        },
      });

      // Subsequent non-locked read should see the mutation in the cache
      const after = ensureAuthProfileStore(agentDir);
      expect(after.usageStats?.["openai:default"]?.lastUsed).toBe(123);
    } finally {
      clearSecretsRuntimeSnapshot();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
