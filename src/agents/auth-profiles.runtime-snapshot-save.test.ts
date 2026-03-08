import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  ensureAuthProfileStore,
  markAuthProfileUsed,
  saveAuthProfileStore,
} from "./auth-profiles.js";

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

  it("syncs activeSnapshot authStores when saveAuthProfileStore is called", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-runtime-save-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "oauth",
              provider: "anthropic",
              access: "old-access",
              refresh: "old-refresh",
              expires: 1000,
            },
          },
        }),
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: {},
        agentDirs: [agentDir],
      });
      activateSecretsRuntimeSnapshot(snapshot);

      // Simulate an OAuth token refresh that calls saveAuthProfileStore
      const store = ensureAuthProfileStore(agentDir);
      store.profiles["anthropic:default"] = {
        type: "oauth",
        provider: "anthropic",
        access: "new-access",
        refresh: "new-refresh",
        expires: 9999,
      };
      saveAuthProfileStore(store, agentDir);

      // activeSnapshot should reflect the updated credentials
      const active = getActiveSecretsRuntimeSnapshot();
      const entry = active?.authStores.find((e) => e.agentDir === agentDir);
      expect(entry?.store.profiles["anthropic:default"]).toMatchObject({
        access: "new-access",
        refresh: "new-refresh",
        expires: 9999,
      });

      // ensureAuthProfileStore should also return the updated credentials
      const refreshed = ensureAuthProfileStore(agentDir);
      expect(refreshed.profiles["anthropic:default"]).toMatchObject({
        access: "new-access",
        refresh: "new-refresh",
        expires: 9999,
      });
    } finally {
      clearSecretsRuntimeSnapshot();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
