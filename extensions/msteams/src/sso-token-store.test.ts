import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsSsoTokenStoreFs } from "./sso-token-store.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";
import { useMSTeamsStateTempDirs } from "./test-support/state.js";

const tempDirs = useMSTeamsStateTempDirs();

const makeToken = (connectionName: string, userId: string, token: string) => ({
  connectionName,
  userId,
  token,
  updatedAt: "2026-04-10T00:00:00.000Z",
});
let stateDir: string;

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  resetPluginStateStoreForTests();
  setMSTeamsRuntime(msteamsRuntimeStub);
  stateDir = tempDirs.make("openclaw-msteams-sso-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

it("keeps distinct tokens when connectionName and userId contain the legacy delimiter", async () => {
  const storePath = path.join(stateDir, "msteams-sso-tokens.json");
  const store = createMSTeamsSsoTokenStoreFs();
  const first = makeToken("conn::alpha", "user", "token-a");
  const second = {
    ...makeToken("conn", "alpha::user", "token-b"),
    updatedAt: "2026-04-10T00:00:01.000Z",
  };

  await store.save(first);
  await store.save(second);

  expect(await store.get(first)).toEqual(first);
  expect(await store.get(second)).toEqual(second);

  await expect(fs.access(storePath)).rejects.toThrow();
  await fs.access(path.join(stateDir, "state", "openclaw.sqlite"));
});

it("ignores legacy flat-key token files at runtime", async () => {
  const storePath = path.join(stateDir, "msteams-sso-tokens.json");
  await fs.writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      tokens: { "legacy::wrong-key": makeToken("conn", "user-1", "token-1") },
    }),
    "utf8",
  );

  const store = createMSTeamsSsoTokenStoreFs();
  expect(await store.get({ connectionName: "conn", userId: "user-1" })).toBeNull();
  await fs.access(storePath);
});

it("preserves migrated default tokens and isolates named-account updates and removal", async () => {
  const token = makeToken("graph", "same-user", "legacy-token");
  const legacyKey = `v2:${createHash("sha256")
    .update(JSON.stringify(["graph", "same-user"]))
    .digest("hex")}`;
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
  const store = createMSTeamsSsoTokenStoreFs();
  const token = makeToken(`conn-${"c".repeat(1000)}`, `user-${"u".repeat(2000)}`, "token-long");

  await store.save(token);
  expect(await store.get(token)).toEqual(token);
  expect(await store.remove(token)).toBe(true);
  expect(await store.get(token)).toBeNull();
});
