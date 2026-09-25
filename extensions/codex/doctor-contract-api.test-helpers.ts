/** Shared fixtures for Codex doctor contract tests. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";

export function createDoctorContext(
  env: NodeJS.ProcessEnv,
  afterRegister?: () => Promise<void>,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStoreForTests<T>("codex", {
        ...options,
        env: options.env ?? env,
      });
      return afterRegister
        ? {
            ...store,
            async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
              const registered = await store.registerIfAbsent(...args);
              await afterRegister();
              return registered;
            },
          }
        : store;
    },
  };
}

export function openBindingStore(env: NodeJS.ProcessEnv) {
  return createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

export async function removeCodexDoctorFixture(stateDir: string): Promise<void> {
  // Doctor migrations open per-agent databases and leave the shared state database open under
  // the temporary state dir; both must be released before removal or Windows keeps the files
  // locked and the removal fails with EBUSY. Agent close first: it releases leases through
  // shared state, so the reverse order can reopen it.
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
}

export async function createBindingMigrationFixture(options: {
  binding?: Record<string, unknown>;
  legacySharedRoot?: boolean;
  name: string;
  sessionIndex?: Record<string, unknown>;
  storeRoot?: "agent" | "fixed";
  threadId: string;
}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionsDir =
    options.storeRoot === "fixed"
      ? path.join(stateDir, "fixed-sessions")
      : options.legacySharedRoot
        ? path.join(stateDir, "sessions")
        : path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const transcriptPath = path.join(sessionsDir, `${options.name}.jsonl`);
  const sidecarPath = `${transcriptPath}.codex-app-server.json`;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "session", id: options.name })}\n`,
    "utf8",
  );
  if (options.sessionIndex !== undefined) {
    await fs.writeFile(storePath, JSON.stringify(options.sessionIndex), "utf8");
  }
  await fs.writeFile(
    sidecarPath,
    JSON.stringify({
      schemaVersion: 2,
      threadId: options.threadId,
      sessionFile: transcriptPath,
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {},
        pluginAppIds: {},
      },
      ...options.binding,
    }),
    "utf8",
  );
  const migration = stateMigrations[0];
  if (!migration) {
    throw new Error("missing Codex binding migration");
  }
  return {
    env,
    migration,
    params: {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    },
    sessionsDir,
    sidecarPath,
    stateDir,
    storePath,
    transcriptPath,
  };
}
