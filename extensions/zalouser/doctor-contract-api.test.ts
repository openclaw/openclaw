import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  listSessionEntries,
  normalizeSessionDeliveryState,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { setZalouserRuntime } from "./src/runtime.js";
import {
  clearStoredZaloCredentials,
  loadStoredZaloCredentials,
  resolveLegacyZalouserCredentialsPath,
  zalouserCredentialStoreKey,
  ZALOUSER_CREDENTIALS_MAX_ENTRIES,
  ZALOUSER_CREDENTIALS_NAMESPACE,
  type StoredZaloCredentials,
} from "./src/session-state.js";

type AuthoredAgents = NonNullable<OpenClawConfig["agents"]>;
// Doctor state migrations receive raw pre-migration config, including retired rosters.
type RawLegacyDoctorAgents = AuthoredAgents & { list?: Array<{ id: string }> };
const legacyCredentials = {
  imei: "imei-1",
  cookie: [{ key: "zpsid", value: "secret", domain: "chat.zalo.me" }],
  userAgent: "user-agent",
  language: "vi",
  lastUsedAt: "2026-07-02T12:00:00.000Z",
};
const skillsSnapshot = { prompt: "Retained session skill context", skills: [] };
const delivery = normalizeSessionDeliveryState({
  context: { channel: "zalouser", accountId: "default" },
});

function findMigration(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing Zalouser state migration: ${id}`);
  }
  return migration;
}
const credentialsMigration = findMigration("zalouser-credentials-json-to-plugin-state");
const sessionMigration = findMigration("zalouser-direct-session-keys");

describe("zalouser doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  function doctorParams(config: OpenClawConfig = {}) {
    const context: PluginDoctorStateMigrationContext = {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStoreForTests("zalouser", { ...options, env: options.env ?? env }),
    };
    return { config, env, stateDir, oauthDir: stateDir, context };
  }

  async function writeLegacyCredentials(profile: string) {
    const filePath = resolveLegacyZalouserCredentialsPath(profile, env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacyCredentials));
    return filePath;
  }

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    // Plugin-state reset leaves agent handles open; close them before removal on Windows.
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("retains malformed UTF-8 credentials while importing a healthy profile", async () => {
    const filePath = await writeLegacyCredentials("broken");
    const healthyPath = await writeLegacyCredentials("healthy");
    const createdAt = (await fs.stat(healthyPath)).mtime.toISOString();
    const bytes = Buffer.from(JSON.stringify({ ...legacyCredentials, userAgent: "utf8-marker" }));
    bytes[bytes.indexOf("utf8-marker")] = 0xff;
    await fs.writeFile(filePath, bytes);
    const params = doctorParams();
    const result = await credentialsMigration.migrateLegacyState(params);
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings).toHaveLength(1);
    expect(await fs.readFile(filePath)).toEqual(bytes);
    await expect(fs.access(healthyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.access(`${healthyPath}.migrated`);
    const store = params.context.openPluginStateKeyedStore<StoredZaloCredentials>({
      namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
      maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    expect(await store.lookup(zalouserCredentialStoreKey("broken"))).toBeUndefined();
    expect(await store.lookup(zalouserCredentialStoreKey("healthy"))).toEqual({
      profile: "healthy",
      ...legacyCredentials,
      createdAt,
    });
  });

  it("archives legacy credentials without restoring an explicitly cleared profile", async () => {
    const filePath = await writeLegacyCredentials("work");
    const params = doctorParams();
    expect(await credentialsMigration.detectLegacyState(params)).not.toBeNull();
    const runtime = createPluginRuntimeMock();
    runtime.state.openKeyedStoreV2 = (options, authority) =>
      createPluginStateKeyedStoreV2ForTests(
        "zalouser",
        { ...options, env: options.env ?? env },
        authority ?? { assertCurrent() {} },
      );
    setZalouserRuntime(runtime);
    await clearStoredZaloCredentials("work", env);
    await expect(credentialsMigration.migrateLegacyState(params)).resolves.toMatchObject({
      warnings: [],
    });
    await expect(loadStoredZaloCredentials("work", env)).resolves.toBeNull();
    await fs.access(`${filePath}.migrated`);
  });

  it("does not inspect agent session stores when zalouser has never been configured", async () => {
    const config = { agents: { entries: { "worker-1": {} } } };
    await expect(sessionMigration.detectLegacyState(doctorParams(config))).resolves.toBeNull();
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each<[string, string, RawLegacyDoctorAgents, boolean?]>([
    ["implicit main", "main", {}],
    ["legacy list", "worker-1", { list: [{ id: "worker-1" }] }],
    ["keyed entries", "worker-1", { entries: { "worker-1": {} } }],
    ["identity-linked collision", "main", {}, true],
  ])("migrates sessions for %s", async (_roster, agentId, agents, collision) => {
    const legacyKey = `agent:${agentId}:zalouser:group:user-1`;
    const canonicalKey = `agent:${agentId}:zalouser:direct:${collision ? "alice" : "user-1"}`;
    const groupKey = `agent:${agentId}:zalouser:group:room-1`;
    const storePath = collision ? path.join(stateDir, "sessions.json") : undefined;
    const scope = { agentId, env, storePath: resolveStorePath(storePath, { agentId, env }) };
    const put = (
      sessionKey: string,
      sessionId: string,
      updatedAt: number,
      chatType: "direct" | "group" = "direct",
    ) =>
      upsertSessionEntry({
        ...scope,
        sessionKey,
        entry: { sessionId, updatedAt, chatType, skillsSnapshot, delivery },
      });
    const params = doctorParams({
      agents,
      channels: { zalouser: {} },
      session: {
        store: storePath,
        dmScope: "per-channel-peer",
        identityLinks: collision ? { alice: ["zalouser:user-1", "zalouser:user-2"] } : undefined,
      },
    });
    const retained = { sessionId: "new", updatedAt: 5, chatType: "direct", skillsSnapshot };
    await put(legacyKey, "new", 5);
    await put(groupKey, "group-session", 2, "group");
    if (collision) {
      await put(`agent:${agentId}:zalouser:group:user-2`, "older", 2);
      await put(canonicalKey, "canonical", 4);
    }
    expect(await sessionMigration.detectLegacyState(params)).not.toBeNull();
    await expect(sessionMigration.migrateLegacyState(params)).resolves.toMatchObject({
      warnings: [],
    });
    const entries = new Map(
      listSessionEntries(scope).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
    expect([...entries.keys()].toSorted()).toEqual([canonicalKey, groupKey]);
    expect(entries.get(canonicalKey)).toMatchObject(retained);
  });
});
