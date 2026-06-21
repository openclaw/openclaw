// Codex tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("codex", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("codex doctor contract", () => {
  it("reports the retired dynamic tools profile config key", () => {
    expect(
      legacyConfigRules[0]?.match({
        codexDynamicToolsProfile: "openclaw-compat",
        codexDynamicToolsLoading: "direct",
      }),
    ).toBe(true);
    expect(legacyConfigRules[0]?.match({ codexDynamicToolsLoading: "direct" })).toBe(false);
  });

  it("reports old approval-routed destructive plugin policy values", () => {
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "on-request",
        plugins: {},
      }),
    ).toBe(true);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: true,
        plugins: {
          "google-calendar": { allow_destructive_actions: "on-request" },
        },
      }),
    ).toBe(true);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": { allow_destructive_actions: true },
        },
      }),
    ).toBe(false);
  });

  it("removes the retired dynamic tools profile without dropping other Codex config", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexDynamicToolsProfile: "openclaw-compat",
              codexDynamicToolsLoading: "direct",
              codexDynamicToolsExclude: ["custom_tool"],
              appServer: { mode: "guardian" },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      codexDynamicToolsLoading: "direct",
      codexDynamicToolsExclude: ["custom_tool"],
      appServer: { mode: "guardian" },
    });
    expect(original.plugins.entries.codex.config).toHaveProperty("codexDynamicToolsProfile");
  });

  it("imports shipped binding sidecars under session and legacy conversation identities", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const transcriptPath = path.join(sessionsDir, "session-current.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    const legacyBinding = {
      schemaVersion: 1,
      threadId: "thread-1",
      sessionFile: transcriptPath,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"session-current"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionId: "session-current",
          sessionFile: "session-current.jsonl",
          totalTokens: 42_000,
          totalTokensFresh: true,
          contextTokens: 258_400,
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(sidecarPath, JSON.stringify(legacyBinding), "utf8");
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-current",
          sessionKey: "agent:main:session-1",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-current",
      binding: { threadId: "thread-1" },
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      binding: {
        threadId: "thread-1",
        cwd: "",
        historyCoveredThrough: expect.any(String),
      },
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(transcriptPath),
        }),
      ),
    ).resolves.not.toHaveProperty("binding.nativeContextUsage");
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      "agent:main:session-1": { sessionId: "session-current", agentHarnessId: "codex" },
    });

    await fs.rm(`${sidecarPath}.migrated`);
    await fs.writeFile(sidecarPath, JSON.stringify(legacyBinding), "utf8");
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();

    const resetTranscript = path.join(sessionsDir, "session-before-reset.jsonl");
    const resetSidecar = `${resetTranscript}.codex-app-server.json`;
    await fs.writeFile(resetTranscript, '{"type":"session","id":"session-before-reset"}\n', "utf8");
    await fs.writeFile(
      resetSidecar,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-before-reset" }),
      "utf8",
    );
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1 safe")],
      warnings: [expect.stringContaining("session owner could not be resolved")],
    });
    await expect(fs.access(resetSidecar)).resolves.toBeUndefined();
    await fs.rm(resetSidecar);

    const conflictingTranscript = path.join(sessionsDir, "session-2.jsonl");
    const conflictingSidecar = `${conflictingTranscript}.codex-app-server.json`;
    await fs.writeFile(conflictingTranscript, '{"type":"session","id":"session-2"}\n', "utf8");
    await fs.writeFile(
      conflictingSidecar,
      JSON.stringify({ schemaVersion: 1, threadId: "legacy-thread" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionId: "session-1",
          sessionFile: "session-1.jsonl",
          updatedAt: Date.now(),
        },
        "agent:main:session-2": {
          sessionId: "session-2",
          sessionFile: "session-2.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    const conflictingSessionKey = bindingStoreKey({
      kind: "session",
      agentId: "main",
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
    });
    await store.register(conflictingSessionKey, {
      version: 1,
      state: "active",
      binding: {
        threadId: "legacy-thread",
        cwd: "/repo",
        historyCoveredThrough: "2026-01-01T00:00:00.000Z",
      },
    });

    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [],
      warnings: [
        expect.stringContaining(`canonical plugin state changed at ${conflictingSessionKey}`),
      ],
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(conflictingTranscript),
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(fs.access(conflictingSidecar)).resolves.toBeUndefined();
    await fs.rm(conflictingSidecar);

    const inverseTranscript = path.join(sessionsDir, "session-3.jsonl");
    const inverseSidecar = `${inverseTranscript}.codex-app-server.json`;
    const inverseConversationKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(inverseTranscript),
    });
    await fs.writeFile(inverseTranscript, '{"type":"session","id":"session-3"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:session-3": {
          sessionId: "session-3",
          sessionFile: "session-3.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      inverseSidecar,
      JSON.stringify({ schemaVersion: 1, threadId: "session-thread" }),
      "utf8",
    );
    await store.register(inverseConversationKey, {
      version: 1,
      state: "active",
      binding: { threadId: "conversation-thread", cwd: "/repo" },
    });

    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-3",
          sessionKey: "agent:main:session-3",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-3",
      binding: { threadId: "conversation-thread" },
    });
    await expect(store.lookup(inverseConversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "conversation-thread" },
    });
    await expect(fs.access(`${inverseSidecar}.migrated`)).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("does not publish Codex session ownership before every binding row persists", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-order-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const transcriptPath = path.join(sessionsDir, "session-order.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"session-order"}\n', "utf8");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:order": {
          sessionId: "session-order",
          sessionFile: "session-order.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-order" }),
      "utf8",
    );
    const store = createPluginStateKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env,
    });
    const registerIfAbsent = store.registerIfAbsent.bind(store);
    let registerCalls = 0;
    const failingStore: PluginStateKeyedStore<StoredCodexAppServerBinding> = {
      ...store,
      async registerIfAbsent(key, value, opts) {
        registerCalls++;
        if (registerCalls === 2) {
          throw new Error("injected session binding write failure");
        }
        return await registerIfAbsent(key, value, opts);
      },
    };
    const failingContext: PluginDoctorStateMigrationContext = {
      openPluginStateKeyedStore<T>() {
        return failingStore as unknown as PluginStateKeyedStore<T>;
      },
    };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(
      migration.migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: failingContext,
      }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1 safe")],
      warnings: [expect.stringContaining("injected session binding write failure")],
    });
    await expect(fs.readFile(storePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      "agent:main:order": { sessionId: "session-order" },
    });
    expect(
      (JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, Record<string, unknown>>)[
        "agent:main:order"
      ],
    ).not.toHaveProperty("agentHarnessId");
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-order",
          sessionKey: "agent:main:order",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(fs.access(sidecarPath)).resolves.toBeUndefined();

    await expect(
      migration.migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });
    await expect(fs.readFile(storePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      "agent:main:order": {
        sessionId: "session-order",
        agentHarnessId: "codex",
      },
    });
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("retains a shipped binding when its session now belongs to another harness", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-owner-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const transcriptPath = path.join(sessionsDir, "session-foreign.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"session-foreign"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:foreign": {
          sessionId: "session-foreign",
          sessionFile: "session-foreign.jsonl",
          agentHarnessId: "openclaw",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-foreign",
        sessionFile: transcriptPath,
      }),
      "utf8",
    );
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(
      migration.migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      changes: [],
      warnings: [expect.stringContaining("owned by agent harness openclaw")],
    });
    await expect(fs.access(sidecarPath)).resolves.toBeUndefined();
    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-foreign",
          sessionKey: "agent:main:foreign",
        }),
      ),
    ).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports sidecars from the pre-agent session directory before core moves it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-legacy-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "sessions");
    const transcriptPath = path.join(sessionsDir, "legacy-session.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"legacy-session"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:legacy": {
          sessionId: "legacy-session",
          sessionFile: "legacy-session.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "legacy-thread",
        sessionFile: transcriptPath,
      }),
      "utf8",
    );
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({ warnings: [] });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "legacy-session",
          sessionKey: "agent:main:legacy",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "legacy-session",
      binding: { threadId: "legacy-thread" },
    });
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      "agent:main:legacy": { sessionId: "legacy-session", agentHarnessId: "codex" },
    });
  });

  it("preserves the agent-specific store owner for legacy session keys", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-agent-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "research", "sessions");
    const transcriptPath = path.join(sessionsDir, "legacy-research.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"legacy-research"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "legacy-direct": {
          sessionId: "legacy-research",
          sessionFile: "legacy-research.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-research",
        sessionFile: transcriptPath,
      }),
      "utf8",
    );
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(
      migration.migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "research",
          sessionId: "legacy-research",
          sessionKey: "legacy-direct",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "legacy-research",
      binding: { threadId: "thread-research" },
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "legacy-research",
          sessionKey: "legacy-direct",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      "legacy-direct": { sessionId: "legacy-research", agentHarnessId: "codex" },
    });
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("uses the session index when a shipped sidecar transcript is missing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const transcriptPath = path.join(sessionsDir, "missing.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:missing": {
          sessionId: "session-missing",
          sessionFile: "missing.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-legacy-conversation",
        sessionFile: transcriptPath,
      }),
      "utf8",
    );
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(
      migration.migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "thread-legacy-conversation" },
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-missing",
          sessionKey: "agent:main:missing",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-missing",
      binding: { threadId: "thread-legacy-conversation" },
    });
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports a binding without crawling Codex rollout files", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const transcriptPath = path.join(sessionsDir, "session-fresh.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"session-fresh"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:fresh": {
          sessionId: "session-fresh",
          sessionFile: "session-fresh.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-without-rollout" }),
      "utf8",
    );
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(
      migration.migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toEqual({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const targetKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(transcriptPath),
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-fresh",
          sessionKey: "agent:main:fresh",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-fresh",
      binding: { threadId: "thread-without-rollout" },
    });
    await expect(store.lookup(targetKey)).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "thread-without-rollout" },
    });
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("retains an ambiguous sidecar and converges after its owner resolves", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
    const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    const config = {
      agents: { list: [{ id: "alpha" }, { id: "beta" }] },
      session: { store: "~/shared/sessions.json" },
    };
    const sessionsDir = path.join(stateDir, "shared");
    const transcriptPath = path.join(sessionsDir, "ambiguous.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-ambiguous",
        sessionFile: transcriptPath,
      }),
      "utf8",
    );
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(
      migration.migrateLegacyState({
        config,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1 safe")],
      warnings: [expect.stringContaining("session owner could not be resolved")],
    });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({ state: "active", binding: { threadId: "thread-ambiguous" } });
    await expect(fs.access(sidecarPath)).resolves.toBeUndefined();

    const conversationKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(transcriptPath),
    });
    const imported = await store.lookup(conversationKey);
    if (imported?.state !== "active") {
      throw new Error("missing imported Codex conversation binding");
    }
    await store.register(conversationKey, {
      ...imported,
      binding: { ...imported.binding, threadId: "thread-recovered" },
    });
    await expect(
      migration.migrateLegacyState({
        config,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toEqual({
      changes: [],
      warnings: [expect.stringContaining("session owner could not be resolved")],
    });
    await expect(store.lookup(conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "thread-recovered" },
    });

    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:alpha:ambiguous": {
          sessionId: "session-ambiguous",
          sessionFile: "ambiguous.jsonl",
          totalTokens: 12_345,
          totalTokensFresh: true,
          contextTokens: 128_000,
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await expect(
      migration.migrateLegacyState({
        config,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "alpha",
          sessionId: "session-ambiguous",
          sessionKey: "agent:alpha:ambiguous",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-ambiguous",
      binding: { threadId: "thread-recovered" },
    });
    await expect(store.lookup(conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: {
        threadId: "thread-recovered",
      },
    });
    await expect(store.lookup(conversationKey)).resolves.not.toHaveProperty(
      "binding.nativeContextUsage",
    );
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("uses canonical custom-store, agent, and nested transcript path resolution", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
    const customStoreRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-custom-store-"),
    );
    const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    const config = {
      agents: { list: [{ id: "alpha" }] },
      session: { store: path.join(customStoreRoot, "{agentId}", "sessions.json") },
    };
    const sessionsDir = path.join(customStoreRoot, "alpha");
    const transcriptPath = path.join(sessionsDir, "nested", "session-custom.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"session-custom"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:alpha:custom": {
          sessionId: "session-custom",
          sessionFile: "nested/session-custom.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-custom" }),
      "utf8",
    );
    const unrelatedSidecar = path.join(
      customStoreRoot,
      "unrelated",
      `not-a-session.jsonl.codex-app-server.json`,
    );
    await fs.mkdir(path.dirname(unrelatedSidecar), { recursive: true });
    await fs.writeFile(
      unrelatedSidecar,
      JSON.stringify({ schemaVersion: 1, threadId: "unrelated-thread" }),
      "utf8",
    );
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await migration.migrateLegacyState({
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "alpha",
          sessionId: "session-custom",
          sessionKey: "agent:alpha:custom",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-custom",
      binding: { threadId: "thread-custom" },
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "thread-custom" },
    });
    await expect(fs.access(unrelatedSidecar)).resolves.toBeUndefined();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(customStoreRoot, { recursive: true, force: true });
  });
});
