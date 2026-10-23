import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirHarness } from "../../temp-dir.test-helper.js";
import { readQaAuthProfiles, writeQaAuthProfiles } from "./auth-store.js";
import { stageQaMockAuthProfiles } from "./mock-auth.js";

const tempDirs = createTempDirHarness();
const apiKey = (provider = "openai") => ({ type: "api_key" as const, provider, key: "qa-fake" });
const mockProfiles = { "qa-mock-openai": apiKey() };

async function writeUnreadableDatabase(databasePath: string, kind: "future" | "invalid") {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  if (kind === "future") {
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version = 999");
    database.close();
  } else {
    await fs.writeFile(databasePath, "not a SQLite database");
  }
}

async function createQaAuthState() {
  const stateDir = await tempDirs.makeTempDir("openclaw-qa-auth-store-");
  const agentId = "main";
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return {
    stateDir,
    agentDir: path.join(stateDir, "agents", agentId, "agent"),
    write: (
      profiles: Parameters<typeof writeQaAuthProfiles>[0]["profiles"] = mockProfiles,
      replace = false,
    ) => writeQaAuthProfiles({ agentId, stateDir, profiles, replace }),
  };
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

it("keeps inherited host shared state unchanged while staging isolated profiles", async () => {
  const hostStateDir = await tempDirs.makeTempDir("openclaw-qa-auth-host-state-");
  const { stateDir, agentDir, write } = await createQaAuthState();
  const hostDatabase = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: hostStateDir },
  });
  const hostDatabasePath = hostDatabase.path;
  await closeOpenClawStateDatabaseAsync();
  const legacyHostDatabase = new DatabaseSync(hostDatabasePath);
  legacyHostDatabase.exec(`
      PRAGMA user_version = 6;
      UPDATE schema_meta SET schema_version = 6 WHERE meta_key = 'primary';
    `);
  legacyHostDatabase.close();
  vi.stubEnv("OPENCLAW_STATE_DIR", hostStateDir);

  await write();

  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const db = new DatabaseSync(hostDatabasePath, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: 6 });
  db.close();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  expect((await readQaAuthProfiles(agentDir)).profiles).toMatchObject({
    "qa-mock-openai": { provider: "openai" },
  });
});

it.each(["future", "invalid"] as const)("isolates concurrent staging from %s", async (kind) => {
  const hostStateDir = await tempDirs.makeTempDir("openclaw-qa-auth-unreadable-host-");
  const hostDatabasePath = path.join(hostStateDir, "state", "openclaw.sqlite");
  await writeUnreadableDatabase(hostDatabasePath, kind);
  const hostBefore = await fs.readFile(hostDatabasePath);
  const qaRoots = await Promise.all([
    tempDirs.makeTempDir("openclaw-qa-auth-first-"),
    tempDirs.makeTempDir("openclaw-qa-auth-second-"),
  ]);
  vi.stubEnv("OPENCLAW_STATE_DIR", hostStateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", path.join(hostStateDir, "relocated-agent"));

  const configs = await Promise.all(
    qaRoots.map((stateDir, index) =>
      stageQaMockAuthProfiles({
        cfg: {},
        agentIds: ["qa"],
        stateDir,
        providers: [index === 0 ? "openai" : "anthropic"],
      }),
    ),
  );

  for (const [index, stateDir] of qaRoots.entries()) {
    const provider = index === 0 ? "openai" : "anthropic";
    const profileId = `qa-mock-${provider}`;
    const store = await readQaAuthProfiles(path.join(stateDir, "agents", "qa", "agent"));
    expect(Object.keys(store.profiles)).toEqual([profileId]);
    expect(configs[index]?.auth).toEqual({
      profiles: {
        [profileId]: {
          provider,
          mode: "api_key",
          displayName: `QA mock ${provider} credential`,
        },
      },
    });
  }
  expect(await fs.readFile(hostDatabasePath)).toEqual(hostBefore);
  expect(process.env.OPENCLAW_STATE_DIR).toBe(hostStateDir);
  expect(process.env.OPENCLAW_AGENT_DIR).toBe(path.join(hostStateDir, "relocated-agent"));
});

it.each(["future", "invalid"] as const)("refuses a %s target auth database", async (kind) => {
  const { agentDir, write } = await createQaAuthState();
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  await writeUnreadableDatabase(databasePath, kind);
  const before = await fs.readFile(databasePath);
  await expect(write()).rejects.toThrow("unreadable");
  expect(await fs.readFile(databasePath)).toEqual(before);
});

it("refuses to bypass a pending legacy auth source", async () => {
  const { agentDir, write } = await createQaAuthState();
  const authPath = path.join(agentDir, "auth-profiles.json");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(authPath, "{not-json", "utf8");

  await expect(write()).rejects.toThrow("requires legacy credential migration");
  await expect(fs.readFile(authPath, "utf8")).resolves.toBe("{not-json");
});

it("merges canonical API-key, token, and OAuth profile shapes", async () => {
  const { agentDir, write } = await createQaAuthState();
  await write({
    existing: {
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
    tokenProfile: {
      type: "token",
      provider: "github",
      tokenRef: { source: "file", provider: "vault", id: "github/token" },
    },
    oauthProfile: {
      type: "oauth",
      provider: "chatgpt",
      access: "qa-access-token",
      refresh: "qa-refresh-token",
      expires: 1_900_000_000_000,
    },
  });

  await write({ "qa-mock-anthropic": apiKey("anthropic") });

  expect((await readQaAuthProfiles(agentDir)).profiles).toMatchObject({
    existing: { type: "api_key", provider: "openai" },
    tokenProfile: { type: "token", provider: "github" },
    oauthProfile: { type: "oauth", provider: "chatgpt" },
    "qa-mock-anthropic": { type: "api_key", provider: "anthropic" },
  });
  await expect(fs.stat(path.join(agentDir, "auth-profiles.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("can replace an existing profile set for deterministic fixture seeding", async () => {
  const { agentDir, write } = await createQaAuthState();
  saveAuthProfileStore(
    {
      version: 1,
      profiles: { stale: apiKey() },
      order: { openai: ["stale"] },
      lastGood: { openai: "stale" },
      usageStats: { stale: { cooldownUntil: Date.now() + 60_000 } },
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );

  await write({ current: apiKey("anthropic") }, true);

  expect(Object.keys((await readQaAuthProfiles(agentDir)).profiles)).toEqual(["current"]);
  const replaced = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    inheritedAuthDir: agentDir,
  });
  expect(replaced.order).toBeUndefined();
  expect(replaced.lastGood).toBeUndefined();
  expect(replaced.usageStats).toBeUndefined();
});
