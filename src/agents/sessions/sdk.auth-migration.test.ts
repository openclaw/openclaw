import { access, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { snapshotFiles } from "../../infra/state-migrations.caller-mode.test-helpers.js";
import { autoMigrateLegacyState } from "../../infra/state-migrations.doctor.js";
import { inspectLegacyAgentDir } from "../../infra/state-migrations.legacy-sessions.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  inspectOpenClawAgentDatabaseOwner,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  noteAuthProfileFileWrite,
  refreshAuthProfileFileState,
} from "../auth-profiles/file-state.js";
import * as migrationDiagnostics from "../auth-profiles/legacy-source-diagnostic.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "../auth-profiles/legacy-source-diagnostic.js";
import {
  readPersistedAuthProfileStoreRaw as readStore,
  writePersistedAuthProfileStoreRaw as writeStore,
} from "../auth-profiles/sqlite.js";
import type { ApiKeyCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { getAgentDir } from "../config.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const baseUrl = "https://openrouter.ai/api/v1";
const directUrl = "https://api.arcee.ai/api/v1";
const config = { models: { providers: { arcee: { baseUrl, models: [] } } } };
const emptyStore: AuthProfileStore = { version: 1, profiles: {} };
const migrationMessage = "requires legacy credential migration";
const migrationError = { code: "AUTH_PROFILE_MIGRATION_REQUIRED" };

function apiKeyStore(
  provider: string,
  credential: Pick<ApiKeyCredential, "key" | "keyRef">,
): AuthProfileStore {
  return {
    version: 1,
    profiles: { [`${provider}:default`]: { type: "api_key", provider, ...credential } },
  };
}

function withAuthState(
  run: (state: OpenClawTestState, agentDir: string) => Promise<void>,
  env?: Record<string, string | undefined>,
) {
  return withOpenClawTestState(
    { layout: "state-only", prefix: "sdk-auth-", env },
    async (state) => {
      const agentDir = state.agentDir("worker");
      await mkdir(agentDir, { recursive: true });
      await run(state, agentDir);
    },
  );
}

function expectMigrationRequired(ownerDir?: string) {
  expect(() => assertAuthProfileMigrationReady(ownerDir)).toThrow(migrationMessage);
}

function expectKey(actual: string | undefined, expected: string) {
  expect(actual === expected, "selected credential belongs to the expected owner").toBe(true);
}

async function stageLegacy(state: OpenClawTestState, legacy: AuthProfileStore, ownerDir?: string) {
  const file = await state.writeJson(
    `agents/${ownerDir ? "worker" : "main"}/agent/auth-profiles.json`,
    legacy,
  );
  writeStore(emptyStore, ownerDir);
  return file;
}

async function importLegacy(state: OpenClawTestState, legacy: AuthProfileStore) {
  const file = await stageLegacy(state, legacy);
  expectMigrationRequired();
  writeStore(legacy);
  await rename(file, `${file}.migrated`);
}

function authWithFallback(agentDir: string, fallbackKey = "synthetic-other-account-key") {
  const storage = AuthStorage.forAgent(agentDir, config);
  const fallback = vi.fn(() => fallbackKey);
  storage.setFallbackResolver(fallback);
  return { storage, fallback };
}

function atCredentialCheck(change: (assertSelected: () => void) => void) {
  const check = migrationDiagnostics.assertAuthProfileCredentialMigrationStateAtDatabasePath;
  vi.spyOn(
    migrationDiagnostics,
    "assertAuthProfileCredentialMigrationStateAtDatabasePath",
  ).mockImplementationOnce((...args) => change(() => check(...args)));
}

afterEach(() => {
  clearAuthProfileMigrationDiagnostics();
  vi.restoreAllMocks();
});

it("keeps a legacy SDK store when Doctor's configured owner differs", async () => {
  await withOpenClawTestState(
    { label: "sdk-legacy-owner", layout: "home", agentEnv: "clear" },
    async (state) => {
      vi.spyOn(os, "homedir").mockReturnValue(state.home);
      const legacyDir = path.join(state.home, ".openclaw", "agent");
      const databasePath = path.join(legacyDir, "openclaw-agent.sqlite");
      await mkdir(path.join(legacyDir, "bin"), { recursive: true });
      await writeFile(path.join(legacyDir, "bin", "fd"), "installed SDK tool");
      openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: databasePath });
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      // The legacy standalone SDK fixture predates registry enrollment.
      unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: databasePath });
      expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
        status: "owned",
        agentId: "main",
      });
      // Payload inspection materializes native WAL sidecars before the snapshot.
      expect(inspectLegacyAgentDir(legacyDir)).toEqual({ status: "payload" });
      const before = snapshotFiles(legacyDir);
      const cfg = { agents: { entries: { worker: {} } }, plugins: { enabled: false } };
      await state.writeConfig(cfg);
      const result = await autoMigrateLegacyState({
        cfg,
        homedir: () => state.home,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(result.stepReceipts.find((entry) => entry.outcome === "refused")).toBeUndefined();
      const receipt = result.stepReceipts.find((entry) => entry.id === "agent-dir");
      expect(receipt).toMatchObject({
        outcome: "deferred",
        deferred: [
          {
            reason: "owner-mismatch",
            recordedOwner: "main",
            configuredOwner: "worker",
            path: legacyDir,
          },
        ],
        warnings: expect.arrayContaining([
          expect.stringContaining("Keep using the existing store"),
        ]),
      });
      expect(snapshotFiles(legacyDir)).toEqual(before);
      await expect(
        access(path.join(state.agentDir("worker"), ".legacy-agent-dir-migration.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(getAgentDir()).toBe(legacyDir);
    },
  );
});

it.each([
  ["OpenRouter model override", baseUrl, directUrl, true],
  ["direct Arcee model override", directUrl, baseUrl, false],
] as const)(
  "resolves %s before provider dispatch",
  async (_route, modelUrl, configuredUrl, blocked) => {
    await withAuthState(async (state, agentDir) => {
      await stageLegacy(
        state,
        apiKeyStore("openrouter", { key: "synthetic-legacy-key" }),
        agentDir,
      );
      setRuntimeConfigSnapshot({
        models: { providers: { arcee: { baseUrl: configuredUrl, models: [] } } },
      });
      const model = makeProviderModelFixture({
        id: "synthetic-model",
        name: "Synthetic model",
        api: "openai-completions",
        provider: "arcee",
        baseUrl: modelUrl,
        contextWindow: 1000,
        maxTokens: 1000,
      });
      const runtimeConfig = getRuntimeConfig();
      const { session } = await createAgentSession({
        systemPrompt: "Test session prompt",
        modelRegistry: ModelRegistry.create(
          AuthStorage.forAgent(agentDir, runtimeConfig),
          path.join(agentDir, "models.json"),
          { config: runtimeConfig },
        ),
        model,
        thinkingLevel: "medium",
        resourceLoader: await createResourceLoader(),
        settingsManager: SettingsManager.inMemory(),
        sessionManager: SessionManager.inMemory(),
        tools: [],
      });
      const credential = "synthetic-fallback-key";
      const providerIo = vi.fn(() => createAssistantMessageEventStream());
      session.modelRegistry.registerProvider("arcee", {
        api: model.api,
        apiKey: credential,
        streamSimple: providerIo,
      });
      try {
        const stream = session.agent.streamFn;
        if (!stream) {
          throw new Error("SDK stream was not installed");
        }
        const result = Promise.resolve(stream(model, { messages: [] }, {}));
        if (blocked) {
          await expect(result).rejects.toThrow(migrationMessage);
        } else {
          await result;
        }
        expect(providerIo).toHaveBeenCalledTimes(blocked ? 0 : 1);
        if (!blocked) {
          const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
          expect(auth.ok && auth.apiKey === credential, "direct account credential selected").toBe(
            true,
          );
        }
      } finally {
        session.dispose();
      }
    });
  },
);

it("refuses an endpoint-dependent facade request without config", async () => {
  await withAuthState(async (state, agentDir) => {
    await stageLegacy(state, apiKeyStore("openrouter", { key: "synthetic-legacy-key" }), agentDir);
    const storage = AuthStorage.forAgent(agentDir);
    const fallback = vi.fn(() => "synthetic-fallback-key");
    storage.setFallbackResolver(fallback);
    await expect(storage.getApiKey("arcee")).rejects.toMatchObject(migrationError);
    expect(fallback).not.toHaveBeenCalled();
  });
});

it.each([
  { name: "local SecretRef across a shared Arcee refusal", secretRef: true, provider: "arcee" },
  {
    name: "unaffected provider beside a shared Arcee refusal",
    secretRef: false,
    provider: "openai",
  },
])("preserves $name", async ({ secretRef, provider }) => {
  const localKey = "synthetic-local-account-key";
  const otherKey = "synthetic-other-account-key";
  const unaffectedKey = "synthetic-unaffected-account-key";
  await withAuthState(
    async (state, agentDir) => {
      await state.writeJson(
        "agents/main/agent/auth-profiles.json",
        apiKeyStore("arcee", { key: "synthetic-legacy-key" }),
      );
      writeStore(
        apiKeyStore(
          "arcee",
          secretRef
            ? { keyRef: { source: "env", provider: "default", id: "UNRESOLVED_LOCAL_ARCEE" } }
            : { key: localKey },
        ),
        agentDir,
      );
      const fallback = vi.fn(() => otherKey);
      const resolve = async () => {
        const storage = AuthStorage.forAgent(agentDir, config);
        storage.setFallbackResolver(fallback);
        return await storage.getApiKey(provider, provider === "arcee" ? { baseUrl } : undefined);
      };
      if (secretRef) {
        await expect(resolve()).rejects.toThrow(
          "requires the active secrets runtime to materialize SecretRef credentials",
        );
      } else {
        expectKey(await resolve(), provider === "arcee" ? localKey : unaffectedKey);
      }
      expect(fallback).not.toHaveBeenCalled();
    },
    { ARCEEAI_API_KEY: otherKey, OPENAI_API_KEY: unaffectedKey, UNRESOLVED_LOCAL_ARCEE: undefined },
  );
});

it.each(["local", "shared"])(
  "keeps imported %s credentials fenced until lifecycle clear",
  async (owner) => {
    await withAuthState(async (state, agentDir) => {
      const ownerDir = owner === "local" ? agentDir : undefined;
      const legacyPath = `agents/${owner === "local" ? "worker" : "main"}/agent/auth-profiles.json`;
      const importedKey = "synthetic-imported-key";
      const legacy = apiKeyStore("arcee", { key: importedKey });
      const legacyFile = await stageLegacy(state, legacy, ownerDir);
      const { storage, fallback } = authWithFallback(agentDir);
      expectMigrationRequired(ownerDir);
      // Another process's Doctor cannot clear this process's fence.
      writeStore(legacy, ownerDir);
      await rename(legacyFile, `${legacyFile}.migrated`);
      await refreshAuthProfileFileState();
      storage.reload();
      await expect(storage.getApiKey("arcee", { baseUrl })).rejects.toMatchObject(migrationError);
      expect(fallback).not.toHaveBeenCalled();
      clearAuthProfileMigrationDiagnostics();
      storage.reload();
      expectKey(await storage.getApiKey("arcee", { baseUrl }), importedKey);
      if (owner === "shared") {
        const localKey = "synthetic-new-local-key";
        storage.set("arcee", { type: "api_key", key: localKey });
        expect(readStore(agentDir)).toEqual(apiKeyStore("arcee", { key: localKey }));
        writeStore(emptyStore);
        await state.writeJson(legacyPath, legacy);
        await refreshAuthProfileFileState();
        expectMigrationRequired();
        expectKey(await storage.getApiKey("arcee", { baseUrl }), localKey);
      }
    });
  },
);

it("preserves distinct owners for identical imported credential bytes", async () => {
  await withAuthState(
    async (state, agentDir) => {
      const key = "synthetic-same-account-bytes";
      const legacy = apiKeyStore("arcee", { key });
      await importLegacy(state, legacy);
      writeStore(legacy, agentDir);
      const { storage, fallback } = authWithFallback(agentDir);
      expectKey(await storage.getApiKey("arcee", { baseUrl }), key);
      expect(fallback).not.toHaveBeenCalled();
    },
    { UNRESOLVED_IMPORTED_ARCEE: undefined },
  );
});

it("rejects imported credentials across a pending unresolved-Ref reload", async () => {
  await withAuthState(
    async (state, agentDir) => {
      await importLegacy(state, apiKeyStore("arcee", { key: "synthetic-imported-key" }));
      const { storage, fallback } = authWithFallback(agentDir);
      let reloadedSelectedCredential = false;
      atCredentialCheck((assertSelected) => {
        writeStore(
          apiKeyStore("arcee", {
            keyRef: { source: "env", provider: "default", id: "UNRESOLVED_IMPORTED_ARCEE" },
          }),
        );
        storage.reload();
        reloadedSelectedCredential = true;
        assertSelected();
      });
      await expect(storage.getApiKey("arcee", { baseUrl })).rejects.toMatchObject(migrationError);
      expect(reloadedSelectedCredential).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
    },
    { UNRESOLVED_IMPORTED_ARCEE: undefined },
  );
});

it("revalidates the selected owner after another reload changes the view", async () => {
  await withAuthState(async (state, agentDir) => {
    const original = apiKeyStore("arcee", { key: "synthetic-shared-key" });
    await state.writeJson("agents/main/agent/auth-profiles.json", original);
    writeStore(original);
    const storage = AuthStorage.forAgent(agentDir, config);
    const localKey = "synthetic-new-local-key";
    let reloadedSelectedCredential = false;
    atCredentialCheck((assertSelected) => {
      assertSelected();
      writeStore(emptyStore);
      expectMigrationRequired();
      writeStore(apiKeyStore("arcee", { key: localKey }), agentDir);
      noteAuthProfileFileWrite(path.join(agentDir, "openclaw-agent.sqlite"));
      storage.reload();
      reloadedSelectedCredential = true;
    });
    await expect(storage.getApiKey("arcee", { baseUrl })).rejects.toMatchObject(migrationError);
    expect(reloadedSelectedCredential).toBe(true);
    expectKey(await storage.getApiKey("arcee", { baseUrl }), localKey);
  });
});

it.each([
  { provider: "openai", blocked: false },
  { provider: "openrouter", blocked: true },
])("bounds an imported $provider credential's ambiguous realm", async ({ provider, blocked }) => {
  await withAuthState(async (state, agentDir) => {
    const legacyFile = await stageLegacy(
      state,
      apiKeyStore("arcee", { key: "synthetic-legacy-key" }),
    );
    expectMigrationRequired();
    const key = "synthetic-new-account-key";
    writeStore(apiKeyStore(provider, { key }));
    await rename(legacyFile, `${legacyFile}.migrated`);
    const result = AuthStorage.forAgent(agentDir, {}).getApiKey(provider);
    if (blocked) {
      await expect(result).rejects.toMatchObject(migrationError);
    } else {
      expect((await result) === key, "unrelated canonical credential remains usable").toBe(true);
    }
  });
});
