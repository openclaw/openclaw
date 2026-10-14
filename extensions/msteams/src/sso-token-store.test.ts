// Msteams tests cover sso token store plugin behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsSsoTokenStoreFs } from "./sso-token-store.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

describe("msteams sso token store (plugin state)", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("keeps distinct tokens when connectionName and userId contain the legacy delimiter", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-sso-");
    const storePath = path.join(stateDir, "msteams-sso-tokens.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const store = createMSTeamsSsoTokenStoreFs();

    const first = {
      connectionName: "conn::alpha",
      userId: "user",
      token: "token-a",
      updatedAt: "2026-04-10T00:00:00.000Z",
    } as const;
    const second = {
      connectionName: "conn",
      userId: "alpha::user",
      token: "token-b",
      updatedAt: "2026-04-10T00:00:01.000Z",
    } as const;

    await store.save(first);
    await store.save(second);

    expect(await store.get(first)).toEqual(first);
    expect(await store.get(second)).toEqual(second);

    await expect(fs.access(storePath)).rejects.toThrow();
    await fs.access(path.join(stateDir, "state", "openclaw.sqlite"));
  });

  it("ignores legacy flat-key token files at runtime", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-sso-legacy-");
    const storePath = path.join(stateDir, "msteams-sso-tokens.json");
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          tokens: {
            "legacy::wrong-key": {
              connectionName: "conn",
              userId: "user-1",
              token: "token-1",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const store = createMSTeamsSsoTokenStoreFs();
    expect(
      await store.get({
        connectionName: "conn",
        userId: "user-1",
      }),
    ).toBeNull();
    await fs.access(storePath);
  });

  it("preserves migrated default tokens and isolates named-account updates and removal", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-sso-accounts-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const token = {
      connectionName: "graph",
      userId: "same-user",
      token: "legacy-token",
      updatedAt: "2026-04-10T00:00:00.000Z",
    };
    const legacyKey =
      "v2:" +
      createHash("sha256")
        .update(JSON.stringify(["graph", "same-user"]))
        .digest("hex");
    const legacyStore = createPluginStateKeyedStoreForTests<typeof token>("msteams", {
      namespace: "sso-tokens",
      maxEntries: 5000,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await legacyStore.register(legacyKey, token);
    const defaultStore = createMSTeamsSsoTokenStoreFs({ accountId: "default" });
    const namedStore = createMSTeamsSsoTokenStoreFs({ accountId: "support" });
    expect(await defaultStore.get(token)).toEqual(token);
    expect(await namedStore.get(token)).toBeNull();
    await namedStore.save({ ...token, token: "named-token" });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const reopened = createMSTeamsSsoTokenStoreFs({ accountId: "support" });
    expect(await reopened.get(token)).toEqual({ ...token, token: "named-token" });
    expect(await createMSTeamsSsoTokenStoreFs().get(token)).toEqual(token);
    await reopened.remove(token);
    expect(await createMSTeamsSsoTokenStoreFs().get(token)).toEqual(token);
  });

  it("keeps plugin-state keys bounded for long Teams identifiers", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-sso-long-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const store = createMSTeamsSsoTokenStoreFs();
    const token = {
      connectionName: `conn-${"c".repeat(1000)}`,
      userId: `user-${"u".repeat(2000)}`,
      token: "token-long",
      updatedAt: "2026-04-10T00:00:00.000Z",
    } as const;

    await store.save(token);
    expect(await store.get(token)).toEqual(token);
    expect(await store.remove(token)).toBe(true);
    expect(await store.get(token)).toBeNull();
  });
});
