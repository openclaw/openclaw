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
const legacyPath = () => path.join(stateDir, "msteams-sso-tokens.json");

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  resetPluginStateStoreForTests();
  setMSTeamsRuntime(msteamsRuntimeStub);
  stateDir = tempDirs.make("openclaw-msteams-sso-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

it("keeps long delimiter-colliding token keys distinct through removal", async () => {
  const store = createMSTeamsSsoTokenStoreFs();
  const connection = `conn-${"c".repeat(1000)}`;
  const user = `user-${"u".repeat(2000)}`;
  const first = makeToken(`${connection}::alpha`, user, "token-a");
  const second = makeToken(connection, `alpha::${user}`, "token-b");

  await store.save(first);
  await store.save(second);

  expect(await store.get(first)).toEqual(first);
  expect(await store.get(second)).toEqual(second);
  expect(await store.remove(first)).toBe(true);
  expect(await store.get(first)).toBeNull();
  expect(await store.get(second)).toEqual(second);

  await expect(fs.access(legacyPath())).rejects.toThrow();
  await fs.access(path.join(stateDir, "state", "openclaw.sqlite"));
});

it("orders concurrent token changes while isolating account namespaces", async () => {
  const store = createMSTeamsSsoTokenStoreFs();
  const sibling = createMSTeamsSsoTokenStoreFs();
  const named = createMSTeamsSsoTokenStoreFs({ accountId: "support" });
  const first = makeToken("graph", "same-user", "first");
  const replacement = { ...first, token: "replacement" };
  const namedToken = { ...first, token: "named" };

  const save = store.save(first);
  const saveNamed = named.save(namedToken);
  const remove = sibling.remove(first);
  const replace = store.save(replacement);
  await Promise.all([save, saveNamed, expect(remove).resolves.toBe(true), replace]);

  expect(await sibling.get(first)).toEqual(replacement);
  expect(await named.get(first)).toEqual(namedToken);
});

it("ignores legacy flat-key token files at runtime", async () => {
  await fs.writeFile(
    legacyPath(),
    JSON.stringify({
      version: 1,
      tokens: { "legacy::wrong-key": makeToken("conn", "user-1", "token-1") },
    }),
    "utf8",
  );

  const store = createMSTeamsSsoTokenStoreFs();
  expect(await store.get({ connectionName: "conn", userId: "user-1" })).toBeNull();
  await fs.access(legacyPath());
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
