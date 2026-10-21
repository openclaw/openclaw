import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import { createDoctorContext } from "./doctor-contract-api.test-support.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

function openBindingStore<T = StoredCodexAppServerBinding>(env: NodeJS.ProcessEnv) {
  return createDoctorContext(env).openPluginStateKeyedStore<T>({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function sessionBindingKey(sessionId: string, sessionKey: string, agentId = "main") {
  return bindingStoreKey({ kind: "session", agentId, sessionId, sessionKey });
}

function legacySession(sessionId: string, fields: Record<string, unknown> = {}) {
  return { sessionId, sessionFile: `${sessionId}.jsonl`, ...fields };
}

const fixtureDirs: string[] = [];
const migrated = {
  changes: [
    "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
  ],
  warnings: [],
};
const unchanged = { changes: [], warnings: [] };
const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value), "utf8");

function expectWarning(result: { changes: string[]; warnings: string[] }, reason: string) {
  expect(result.changes).toEqual([]);
  expect(result.warnings).toEqual([expect.stringContaining(reason)]);
}

async function expectRetained(sidecarPath: string) {
  await fs.access(sidecarPath);
  await expect(fs.access(`${sidecarPath}.migrated`)).rejects.toThrow();
}

async function expectArchived(sidecarPath: string) {
  await expect(fs.access(sidecarPath)).rejects.toThrow();
  await fs.access(`${sidecarPath}.migrated`);
}

function codexConfig<T extends Record<string, unknown>>(
  config: T,
  siblings: Record<string, { enabled: boolean }> = {},
) {
  return { plugins: { entries: { ...siblings, codex: { enabled: true, config } } } };
}

async function bindingFixture(
  name: string,
  options: {
    binding?: Record<string, unknown>;
    legacySharedRoot?: boolean;
    sessionIndex?: Record<string, unknown>;
    session?: [key: string, fields?: Record<string, unknown>];
    storeRoot?: "agent" | "fixed";
    threadId?: string;
  } = {},
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
  fixtureDirs.push(stateDir);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionsDir =
    options.storeRoot === "fixed"
      ? path.join(stateDir, "fixed-sessions")
      : options.legacySharedRoot
        ? path.join(stateDir, "sessions")
        : path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const transcriptPath = path.join(sessionsDir, `${name}.jsonl`);
  const sidecarPath = `${transcriptPath}.codex-app-server.json`;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(transcriptPath, `${JSON.stringify({ type: "session", id: name })}\n`, "utf8");
  const sessionIndex = options.session
    ? { [options.session[0]]: legacySession(name, options.session[1]) }
    : options.sessionIndex;
  if (sessionIndex !== undefined) {
    await writeJson(storePath, sessionIndex);
  }
  await writeJson(sidecarPath, {
    schemaVersion: 2,
    threadId: options.threadId ?? `thread-${name}`,
    sessionFile: transcriptPath,
    updatedAt: "2026-01-01T00:00:00.000Z",
    pluginAppPolicyContext: {
      fingerprint: "policy-1",
      apps: {},
      pluginAppIds: {},
    },
    ...options.binding,
  });
  const migration = stateMigrations[0];
  assert(migration, "missing Codex binding migration");
  const params = {
    config: {},
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createDoctorContext(env),
  };
  return {
    env,
    migration,
    params,
    migrate: (overrides: Partial<Parameters<typeof migration.migrateLegacyState>[0]> = {}) =>
      migration.migrateLegacyState({ ...params, ...overrides }),
    sessionsDir,
    sidecarPath,
    stateDir,
    storePath,
    transcriptPath,
    conversationKey: bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(transcriptPath),
    }),
    readBinding: async () => {
      const binding = await createStoredCodexAppServerBinding(await readJson(sidecarPath));
      assert(binding, "missing imported Codex binding");
      return binding;
    },
    readSession: (sessionKey: string, agentId = "main", from = storePath) =>
      getSessionEntry({ agentId, env, sessionKey, storePath: from }),
  };
}

afterEach(async () => {
  // Agent leases depend on shared state. Close in this order before removing Windows fixtures.
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  for (const stateDir of fixtureDirs.splice(0)) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

describe("codex doctor contract", () => {
  it("reports and removes retired turn idle settings without changing the run budget", () => {
    const legacy = { turnCompletionIdleTimeoutMs: 123_456 };
    const defaults = { timeoutSeconds: 42 };
    const appServer = {
      requestTimeoutMs: 120_000,
      mode: "guardian",
      headers: { "X-Test": "kept" },
    };
    const plugin = { codexDynamicToolsLoading: "direct", appServer: { ...appServer, ...legacy } };
    const siblings = { unrelated: { enabled: false } };
    const original = { ...codexConfig(plugin, siblings), agents: { defaults } };
    const before = structuredClone(original);
    const rule = legacyConfigRules.find((candidate) =>
      candidate.match(original.plugins.entries.codex.config.appServer),
    );
    expect(rule?.path).toEqual(["plugins", "entries", "codex", "config", "appServer"]);
    expect(rule?.message).toContain("openclaw doctor --fix");

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.config).toEqual({
      ...codexConfig({ ...plugin, appServer }, siblings),
      agents: { defaults },
    });
    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.appServer.turnCompletionIdleTimeoutMs; native Codex owns provider liveness and turn completion. agents.defaults.timeoutSeconds was not changed.",
    ]);
    expect(original).toEqual(before);
    expect(rule?.match(appServer)).toBe(false);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it.each([
    {
      name: "fixed-store-owner",
      sessionKey: "legacy-fixed-store",
      owner: "ops",
      fixed: true,
      defaults: { systemAgent: { agentId: "main" }, sessionStore: { agentId: "ops" } },
      agents: ["main", "ops"],
    },
    {
      name: "system-agent-owner",
      sessionKey: "legacy",
      owner: "main",
      fixed: false,
      defaults: { systemAgent: { agentId: "main" } },
      agents: ["main", "blocker", "digest"],
    },
  ])(
    "migrates $name to its configured session owner",
    async ({ name, sessionKey, owner, fixed, defaults, agents }) => {
      const fixture = await bindingFixture(name, {
        session: [sessionKey, { updatedAt: 1 }],
        storeRoot: fixed ? "fixed" : "agent",
        legacySharedRoot: !fixed,
      });
      const result = await fixture.migrate({
        config: {
          ...(fixed ? { session: { store: fixture.storePath } } : {}),
          agents: {
            ownership: "explicit",
            defaults,
            entries: Object.fromEntries(agents.map((id) => [id, {}])),
          },
        },
      });
      expect(result).toMatchObject(migrated);
      await expect(
        openBindingStore(fixture.env).lookup(sessionBindingKey(name, sessionKey, owner)),
      ).resolves.toMatchObject({ state: "active", sessionId: name });
      expect(fixture.readSession(sessionKey, owner)).toMatchObject({ agentHarnessId: "codex" });
      await fs.access(`${fixture.sidecarPath}.migrated`);
    },
  );

  it("imports and archives shipped binding sidecars", async () => {
    const fixture = await bindingFixture("session-current", {
      session: ["agent:main:session-1", { updatedAt: 1 }],
      threadId: "thread-1",
      binding: {
        pluginAppPolicyContext: {
          fingerprint: "policy-1",
          apps: {
            app: {
              configKey: "app",
              marketplaceName: "openai-curated",
              pluginName: "plugin",
              allowDestructiveActions: true,
              destructiveApprovalMode: "ask",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      },
    });

    await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    await expect(fixture.migrate()).resolves.toMatchObject(migrated);

    const store = openBindingStore(fixture.env);
    await expect(
      store.lookup(sessionBindingKey("session-current", "agent:main:session-1")),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-current",
      binding: {
        threadId: "thread-1",
        pluginAppPolicyContext: {
          apps: { app: { destructiveApprovalMode: "ask" } },
        },
      },
    });
    await expect(store.lookup(fixture.conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "thread-1" },
    });
    await fs.access(`${fixture.sidecarPath}.migrated`);
    expect(fixture.readSession("agent:main:session-1")).toMatchObject({
      sessionId: "session-current",
      agentHarnessId: "codex",
    });
    expect(await readJson(fixture.storePath)).not.toHaveProperty(
      "agent:main:session-1.agentHarnessId",
    );
  });

  it("preserves ambiguous shared-root bindings with a missing system agent", async () => {
    const defaults = { systemAgent: { agentId: "missing" } };
    const fixture = await bindingFixture("explicit-owner", {
      legacySharedRoot: true,
      session: ["legacy", { updatedAt: 1 }],
    });
    const params = {
      ...fixture.params,
      config: {
        agents: { ownership: "explicit" as const, defaults, entries: { main: {}, ops: {} } },
      },
    };

    await expect(fixture.migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    const result = await fixture.migration.migrateLegacyState(params);

    expectWarning(result, "session ownership is indeterminate");
    await expectRetained(fixture.sidecarPath);
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);
  });

  it("normalizes a partial raw conversation import before copying the session row", async () => {
    const threadId = "thread-partial-import";
    const sessionId = "partial-import";
    const sessionKey = "agent:main:partial-import";
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: { legacy: { http_headers: { authorization: "Bearer legacy-secret" } } },
    });
    const rawConversation: StoredCodexAppServerBinding = {
      version: 1,
      state: "active",
      binding: {
        threadId,
        cwd: "",
        dynamicToolsFingerprint: "",
        userMcpServersFingerprint: rawUserMcpServersFingerprint,
      },
    };
    const rawFingerprint = "dynamic-marker"
      .repeat(8_000)
      .slice(0, 65_535 - Buffer.byteLength(JSON.stringify(rawConversation)));
    rawConversation.binding.dynamicToolsFingerprint = rawFingerprint;
    expect(Buffer.byteLength(JSON.stringify(rawConversation))).toBe(65_535);
    expect(Buffer.byteLength(JSON.stringify({ ...rawConversation, sessionId }))).toBeGreaterThan(
      65_536,
    );

    const fixture = await bindingFixture(sessionId, {
      session: [sessionKey],
      threadId,
      binding: {
        dynamicToolsFingerprint: rawFingerprint,
        userMcpServersFingerprint: rawUserMcpServersFingerprint,
      },
    });
    const sessionStateKey = sessionBindingKey(sessionId, sessionKey);
    const store = openBindingStore(fixture.env);
    await store.register(fixture.conversationKey, rawConversation);

    await expect(fixture.migrate()).resolves.toEqual(migrated);

    const expectedBinding = {
      dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawFingerprint),
      userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(rawUserMcpServersFingerprint),
    };
    await expect(store.lookup(fixture.conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: expectedBinding,
    });
    const stored = await store.lookup(sessionStateKey);
    expect(stored).toMatchObject({
      state: "active",
      sessionId,
      binding: expectedBinding,
    });
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(65_536);
    expect(JSON.stringify(stored)).not.toContain("dynamic-marker");
    expect(JSON.stringify(stored)).not.toContain("legacy-secret");
    await expectArchived(fixture.sidecarPath);
    await expect(fixture.migrate()).resolves.toEqual(unchanged);
  });

  it("rejects an explicit session file locator outside the session directory", async () => {
    const sessionKey = "agent:main:stale-locator";
    const fixture = await bindingFixture("stale-locator", {
      session: [sessionKey, { sessionFile: "../outside.jsonl" }],
    });

    const result = await fixture.migrate();

    expectWarning(result, "invalid locator");
    await expectRetained(fixture.sidecarPath);
    expect(fixture.readSession(sessionKey)).toBeUndefined();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);
  });

  it("deduplicates session-store aliases before classifying binding ownership", async () => {
    const fixture = await bindingFixture("aliased-store", {
      session: ["agent:main:aliased-store"],
    });
    await writeJson(fixture.storePath, {
      "agent:main:aliased-store": legacySession("aliased-store", {
        sessionFile: fixture.transcriptPath,
      }),
    });
    const storeAlias = path.join(fixture.stateDir, "sessions-alias.json");
    await fs.symlink(path.join(fixture.sessionsDir, "sessions.json"), storeAlias);

    const result = await fixture.migrate({
      config: { session: { store: storeAlias } },
    });

    expect(result.warnings).toEqual([]);
    await fs.access(`${fixture.sidecarPath}.migrated`);
    const configuredIndex = await readJson(storeAlias);
    const targetIndex = await readJson(fixture.storePath);
    expect(fixture.readSession("agent:main:aliased-store", "main", storeAlias)).toMatchObject({
      agentHarnessId: "codex",
    });
    expect(configuredIndex["agent:main:aliased-store"]).not.toHaveProperty("agentHarnessId");
    expect(targetIndex["agent:main:aliased-store"]).not.toHaveProperty("agentHarnessId");
  });

  it("resolves relative session files from a symlinked store path", async () => {
    const sessionKey = "agent:main:symlinked-store";
    const fixture = await bindingFixture("symlinked-store", {
      session: [sessionKey],
    });
    const configuredDir = path.join(fixture.stateDir, "configured-sessions");
    const configuredStore = path.join(configuredDir, "sessions.json");
    const configuredTranscript = path.join(configuredDir, "symlinked-store.jsonl");
    const configuredSidecar = `${configuredTranscript}.codex-app-server.json`;
    await fs.mkdir(configuredDir, { recursive: true });
    await fs.rename(fixture.transcriptPath, configuredTranscript);
    await fs.rename(fixture.sidecarPath, configuredSidecar);
    const sidecar = await readJson(configuredSidecar);
    await writeJson(configuredSidecar, { ...sidecar, sessionFile: configuredTranscript });
    await fs.symlink(path.join(fixture.sessionsDir, "sessions.json"), configuredStore);

    const result = await fixture.migrate({
      config: { session: { store: configuredStore } },
    });

    expect(result.warnings).toEqual([]);
    await fs.access(`${configuredSidecar}.migrated`);
    expect(fixture.readSession(sessionKey, "main", configuredStore)).toMatchObject({
      agentHarnessId: "codex",
    });
    expect(await readJson(configuredStore)).not.toHaveProperty(`${sessionKey}.agentHarnessId`);
  });

  it.each([
    { label: "unleased", leaseConflict: false },
    { label: "concurrently leased", leaseConflict: true },
  ])(
    "revalidates a $label session row when its owner rebinds during migration",
    async ({ leaseConflict }) => {
      const sessionKey = "agent:main:session-1";
      const fixture = await bindingFixture("session-current", {
        session: [sessionKey, { lifecycleRevision: "rev-1" }],
        threadId: "thread-1",
      });
      const sessionStateKey = sessionBindingKey("session-current", sessionKey);
      const imported = await fixture.readBinding();
      const store = openBindingStore(fixture.env);
      const sessionRow = { ...imported, sessionId: "session-current" };
      await store.register(sessionStateKey, sessionRow);
      let rebound = false;
      let leased = false;
      const context = createDoctorContext(
        fixture.env,
        async () => {
          if (rebound) {
            return;
          }
          rebound = true;
          await upsertSessionEntry({
            agentId: "main",
            env: fixture.env,
            sessionKey,
            storePath: fixture.storePath,
            entry: {
              sessionId: "session-current",
              lifecycleRevision: "rev-2",
              updatedAt: Date.now(),
            },
          });
        },
        async (key) => {
          if (!leaseConflict || leased || key !== sessionStateKey) {
            return;
          }
          leased = true;
          await store.register(key, {
            ...sessionRow,
            lease: { token: "concurrent-owner", expiresAt: Date.now() + 60_000 },
          });
        },
      );

      const result = await fixture.migrate({ context });

      if (leaseConflict) {
        expect(result.warnings).toEqual([
          expect.stringContaining("its stale session binding could not be retired"),
        ]);
        expect(result.notices ?? []).toEqual([]);
      } else {
        expect(result.warnings).toEqual([]);
        expect(result.notices).toEqual([
          expect.stringContaining("session owner changed before Codex ownership could be recorded"),
        ]);
      }
      await expectRetained(fixture.sidecarPath);
      expect(await readJson(fixture.storePath)).not.toHaveProperty(`${sessionKey}.agentHarnessId`);
      expect(fixture.readSession(sessionKey)).toMatchObject({ lifecycleRevision: "rev-2" });
      await expect(store.lookup(sessionStateKey)).resolves.toMatchObject(
        leaseConflict
          ? { ...sessionRow, lease: { token: "concurrent-owner" } }
          : { version: 1, state: "cleared", sessionId: "session-current", retired: true },
      );
    },
  );

  it("does not resurrect a retired session generation from its legacy sidecar", async () => {
    const sessionKey = "agent:main:retired";
    const fixture = await bindingFixture("retired", {
      session: [sessionKey],
    });
    const store = openBindingStore(fixture.env);
    const active = await fixture.readBinding();
    await store.register(fixture.conversationKey, active);
    const sessionStateKey = sessionBindingKey("retired", sessionKey);
    const retired: StoredCodexAppServerBinding = {
      version: 1,
      state: "cleared",
      sessionId: "retired",
      retired: true,
    };
    await store.register(sessionStateKey, retired);

    const result = await fixture.migrate();

    expectWarning(result, `current plugin state changed at ${sessionStateKey}`);
    await fs.access(fixture.sidecarPath);
    await expect(store.lookup(sessionStateKey)).resolves.toEqual(retired);
    expect(await readJson(fixture.storePath)).not.toHaveProperty(`${sessionKey}.agentHarnessId`);
  });

  it("archives zero-owner sidecars without changing cleared conversation state", async () => {
    const fixture = await bindingFixture("orphan-cleared");
    const existing: StoredCodexAppServerBinding = { version: 1, state: "cleared", retired: true };
    const store = openBindingStore(fixture.env);
    await store.register(fixture.conversationKey, existing);

    await expect(fixture.migrate()).resolves.toEqual(migrated);
    await expectArchived(fixture.sidecarPath);
    await expect(store.lookup(fixture.conversationKey)).resolves.toEqual(existing);
    await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toBeNull();
    await expect(fixture.migrate()).resolves.toEqual(unchanged);
  });

  it("ignores metadata-only session rows when proving zero ownership", async () => {
    const fixture = await bindingFixture("orphan-metadata-row", {
      sessionIndex: {
        "agent:main:metadata-only": {
          label: "Waiting for first turn",
          updatedAt: 1,
        },
      },
    });

    await expect(fixture.migrate()).resolves.toEqual(migrated);
    await expectArchived(fixture.sidecarPath);
  });

  it("retains a zero-owner sidecar when canonical plugin state is malformed", async () => {
    const fixture = await bindingFixture("orphan-invalid-state");
    const store = openBindingStore<unknown>(fixture.env);
    const malformed = { version: 1, state: "active" };
    await store.register(fixture.conversationKey, malformed);

    const result = await fixture.migrate();

    expectWarning(result, `current plugin state is invalid at ${fixture.conversationKey}`);
    await fs.access(fixture.sidecarPath);
    await expect(store.lookup(fixture.conversationKey)).resolves.toEqual(malformed);
  });

  it("retains mixed Codex and foreign ambiguous binding owners", async () => {
    const fixture = await bindingFixture("shared", {
      sessionIndex: {
        "agent:main:first": legacySession("first", {
          sessionFile: "shared.jsonl",
          agentHarnessId: "codex",
        }),
        "agent:main:second": legacySession("second", {
          sessionFile: "shared.jsonl",
          agentHarnessId: "pi",
        }),
      },
    });

    const result = await fixture.migrate();

    expectWarning(result, "2 matching session owners make ownership ambiguous");
    await fs.access(fixture.sidecarPath);
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);
  });

  it("retains a sidecar owned by a foreign harness without importing plugin state", async () => {
    const fixture = await bindingFixture("foreign", {
      session: ["agent:main:foreign", { agentHarnessId: "pi" }],
    });

    const result = await fixture.migrate();

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([expect.stringContaining("owned by agent harness pi")]);
    await fs.access(fixture.sidecarPath);
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);
  });

  it.each([
    { contents: "{", detail: "invalid JSON", label: "invalid JSON" },
    {
      contents: JSON.stringify({
        "agent:main:invalid": { sessionId: "invalid", agentHarnessId: 42 },
      }),
      detail: "invalid entries",
      label: "malformed harness metadata",
    },
    {
      contents: JSON.stringify({
        "agent:main:unsafe": { sessionId: "../unsafe", sessionFile: "unsafe.jsonl" },
      }),
      detail: "invalid entries",
      label: "unsafe session id",
    },
  ])("retains binding sidecars for an indeterminate $label index", async ({ contents, detail }) => {
    const fixture = await bindingFixture("unknown-owner");
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-store-"));
    fixtureDirs.push(externalDir);
    const externalStore = path.join(externalDir, "sessions.json");
    await fs.writeFile(externalStore, contents, "utf8");
    const params = {
      ...fixture.params,
      config: { session: { store: externalStore } },
    };

    const result = await fixture.migration.migrateLegacyState(params);

    expectWarning(result, "session index");
    expect(result.warnings[0]).toContain(detail);
    await expectRetained(fixture.sidecarPath);
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);
  });

  it("does not scan above stateDir or follow escaped external store locators", async () => {
    const outerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-outer-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-outside-"));
    fixtureDirs.push(outerDir, outsideDir);
    const stateDir = path.join(outerDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const strayDir = path.join(outerDir, "unrelated");
    await fs.mkdir(strayDir, { recursive: true });
    const externalStore = path.join(outerDir, "sessions.json");
    await writeJson(path.join(strayDir, "foreign.jsonl.codex-app-server.json"), {
      schemaVersion: 2,
      threadId: "thread-foreign",
    });
    await writeJson(path.join(outsideDir, "foreign.jsonl.codex-app-server.json"), {
      schemaVersion: 2,
      threadId: "thread-escaped",
    });
    await fs.symlink(outsideDir, path.join(outerDir, "escaped"));
    // A missing transcript through an escaping symlink must resolve its existing ancestor.
    await writeJson(externalStore, {
      "agent:main:foreign": legacySession("foreign", { sessionFile: "escaped/foreign.jsonl" }),
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const params = {
      // The store directory is exactly stateDir's parent. It stays indexed-only,
      // and its explicit locator cannot escape that directory.
      config: { session: { store: externalStore } },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
    const migration = stateMigrations[0];
    assert(migration, "missing Codex binding migration");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
  });

  it("renames old approval-routed destructive plugin policy values", () => {
    const policy = (allow_destructive_actions: string | boolean) => ({
      enabled: true,
      allow_destructive_actions,
    });
    const original = codexConfig({
      codexDynamicToolsProfile: "openclaw-compat",
      codexPlugins: {
        ...policy("on-request"),
        plugins: { "google-calendar": policy("on-request"), slack: policy(false) },
      },
    });

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      codexPlugins: {
        ...policy("auto"),
        plugins: { "google-calendar": policy("auto"), slack: policy(false) },
      },
    });
    expect(
      original.plugins.entries.codex.config.codexPlugins.plugins["google-calendar"]
        .allow_destructive_actions,
    ).toBe("on-request");
  });

  it.each(["untrusted"])("renames the retired app-server %s approval policy", (approvalPolicy) => {
    const original = codexConfig({ appServer: { approvalPolicy, sandbox: "workspace-write" } });

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      'Renamed retired plugins.entries.codex.config.appServer.approvalPolicy to "on-request".',
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      appServer: {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    });
    expect(original.plugins.entries.codex.config.appServer.approvalPolicy).toBe(approvalPolicy);
  });
});
