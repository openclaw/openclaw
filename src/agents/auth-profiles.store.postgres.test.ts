import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const persistedStores = vi.hoisted(() => new Map<string, AuthProfileStore>());
const persistAuthProfileStoreToPostgresMock = vi.hoisted(() =>
  vi.fn(async (params: { store: AuthProfileStore; agentDir?: string }) => {
    persistedStores.set(
      path.resolve(params.agentDir ?? path.join(os.tmpdir(), "openclaw-auth-main")),
      structuredClone(params.store),
    );
  }),
);
const loadAuthProfileStoreSnapshotsFromPostgresMock = vi.hoisted(() =>
  vi.fn(async () =>
    [...persistedStores.entries()].map(([agentDir, store]) => ({
      agentDir,
      store: structuredClone(store),
    })),
  ),
);

vi.mock("../config/config.js", () => ({
  getRuntimeConfigSnapshot: () => ({
    persistence: {
      backend: "postgres",
      postgres: { url: "postgresql://openclaw:test@localhost/openclaw" },
    },
  }),
  loadConfig: () => ({
    persistence: {
      backend: "postgres",
      postgres: { url: "postgresql://openclaw:test@localhost/openclaw" },
    },
  }),
}));

vi.mock("../persistence/postgres-client.js", () => ({
  getRuntimePostgresPersistencePolicySync: () => ({
    enabled: true,
    exportCompatibility: false,
  }),
}));

vi.mock("../persistence/runtime.js", () => ({
  hasBootstrappedPostgresAuthRuntimeState: () => true,
}));

vi.mock("../persistence/service.js", () => ({
  loadAuthProfileStoreSnapshotsFromPostgres: () => loadAuthProfileStoreSnapshotsFromPostgresMock(),
  persistAuthProfileStoreToPostgres: (params: { store: AuthProfileStore; agentDir?: string }) =>
    persistAuthProfileStoreToPostgresMock(params),
}));

const {
  ensureAuthProfileStore,
  clearRuntimeAuthProfileStoreSnapshots,
  updateAuthProfileStoreWithLock,
} = await import("./auth-profiles/store.js");
const { upsertAuthProfile } = await import("./auth-profiles/profiles.js");

describe("auth profile postgres runtime snapshot", () => {
  let agentDir = "";

  beforeEach(async () => {
    persistedStores.clear();
    persistAuthProfileStoreToPostgresMock.mockClear();
    loadAuthProfileStoreSnapshotsFromPostgresMock.mockClear();
    clearRuntimeAuthProfileStoreSnapshots();
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-postgres-"));
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    if (agentDir) {
      await fs.rm(agentDir, { recursive: true, force: true });
      agentDir = "";
    }
  });

  it("keeps earlier profiles when sequential writes start from an empty postgres store", async () => {
    await upsertAuthProfile({
      profileId: "opencode:default",
      credential: {
        type: "api_key",
        provider: "opencode",
        key: "sk-opencode",
      },
      agentDir,
    });
    await upsertAuthProfile({
      profileId: "opencode-go:default",
      credential: {
        type: "api_key",
        provider: "opencode-go",
        key: "sk-opencode-go",
      },
      agentDir,
    });

    const store = ensureAuthProfileStore(agentDir);
    expect(Object.keys(store.profiles).toSorted()).toEqual([
      "opencode-go:default",
      "opencode:default",
    ]);
    expect(persistAuthProfileStoreToPostgresMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows hard postgres persistence failures instead of converting them to null", async () => {
    persistAuthProfileStoreToPostgresMock.mockRejectedValueOnce(new Error("postgres unavailable"));

    await expect(
      updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.profiles["openai:default"] = {
            type: "api_key",
            provider: "openai",
            key: "sk-openai",
          };
          return true;
        },
      }),
    ).rejects.toThrow("postgres unavailable");
  });
});
