import { access, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { snapshotFiles } from "../../infra/state-migrations.caller-mode.test-helpers.js";
import { autoMigrateLegacyState } from "../../infra/state-migrations.doctor.js";
import type { Model } from "../../llm/types.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  inspectOpenClawAgentDatabaseOwner,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "../auth-profiles/legacy-source-diagnostic.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import type { ApiKeyCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { getAgentDir } from "../config.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

function apiKeyStore(
  provider: string,
  credential: Pick<ApiKeyCredential, "key" | "keyRef">,
): AuthProfileStore {
  return {
    version: 1,
    profiles: { [`${provider}:default`]: { type: "api_key", provider, ...credential } },
  };
}

const legacyOpenRouter = apiKeyStore("openrouter", { key: "synthetic-legacy-key" });
const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

afterEach(() => {
  clearAuthProfileMigrationDiagnostics();
  vi.restoreAllMocks();
});

it("keeps a legacy SDK store when Doctor's configured owner differs", async () => {
  await withOpenClawTestState(
    { label: "sdk-legacy-owner", layout: "split", agentEnv: "clear" },
    async (state) => {
      vi.spyOn(os, "homedir").mockReturnValue(state.home);
      const legacyDir = path.join(state.home, ".openclaw", "agent");
      const databasePath = path.join(legacyDir, "openclaw-agent.sqlite");
      await mkdir(path.join(legacyDir, "bin"), { recursive: true });
      await writeFile(path.join(legacyDir, "bin", "fd"), "installed SDK tool");
      openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: databasePath });
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
        status: "owned",
        agentId: "main",
      });
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
      });
      expect(receipt?.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Keep using the existing store")]),
      );
      expect(snapshotFiles(legacyDir)).toEqual(before);
      await expect(
        access(path.join(state.agentDir("worker"), ".legacy-agent-dir-migration.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(getAgentDir()).toBe(legacyDir);
    },
  );
});

describe("SDK migration guard endpoint context", () => {
  it.each<{
    route: string;
    baseUrl: string;
    configuredBaseUrl?: string;
    blocked: boolean;
  }>([
    {
      route: "OpenRouter model override",
      baseUrl: "https://openrouter.ai/api/v1",
      configuredBaseUrl: "https://api.arcee.ai/api/v1",
      blocked: true,
    },
    {
      route: "direct Arcee model override",
      baseUrl: "https://api.arcee.ai/api/v1",
      configuredBaseUrl: "https://openrouter.ai/api/v1",
      blocked: false,
    },
  ])(
    "resolves $route before provider dispatch",
    async ({ baseUrl, configuredBaseUrl, blocked }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "sdk-auth-endpoint-" },
        async (state) => {
          await state.writeJson("agents/worker/agent/auth-profiles.json", legacyOpenRouter);
          const agentDir = state.agentDir("worker");
          await mkdir(agentDir, { recursive: true });
          writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
          if (configuredBaseUrl) {
            setRuntimeConfigSnapshot({
              models: { providers: { arcee: { baseUrl: configuredBaseUrl, models: [] } } },
            });
          }
          const model: Model = {
            ...testModel,
            id: "synthetic-model",
            name: "Synthetic model",
            api: "openai-completions",
            provider: "arcee",
            baseUrl,
          };
          const config = getRuntimeConfig();
          const authStorage = AuthStorage.forAgent(agentDir, config);
          const { session } = await createAgentSession({
            systemPrompt: "Test session prompt",
            modelRegistry: ModelRegistry.create(authStorage, path.join(agentDir, "models.json"), {
              config,
            }),
            model,
            thinkingLevel: "medium",
            resourceLoader: createResourceLoader(),
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
            const decision = await Promise.resolve(stream(model, { messages: [] }, {})).then(
              () => "allowed",
              (error: unknown) => {
                if (
                  error instanceof Error &&
                  error.message.includes("requires legacy credential migration")
                ) {
                  return "migration-required";
                }
                throw error;
              },
            );
            expect(decision).toBe(blocked ? "migration-required" : "allowed");
            expect(providerIo).toHaveBeenCalledTimes(blocked ? 0 : 1);
            if (!blocked) {
              const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
              expect(
                auth.ok && auth.apiKey === credential,
                "direct account credential selected",
              ).toBe(true);
            }
          } finally {
            session.dispose();
          }
        },
      );
    },
  );

  it("refuses an endpoint-dependent facade request without config", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "auth-no-endpoint-" },
      async (state) => {
        await state.writeJson("agents/worker/agent/auth-profiles.json", legacyOpenRouter);
        const agentDir = state.agentDir("worker");
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
        const storage = AuthStorage.forAgent(agentDir);
        const fallback = vi.fn(() => "synthetic-fallback-key");
        storage.setFallbackResolver(fallback);
        await expect(storage.getApiKey("arcee")).rejects.toMatchObject({
          code: "AUTH_PROFILE_MIGRATION_REQUIRED",
        });
        expect(fallback).not.toHaveBeenCalled();
      },
    );
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
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "auth-owner-preservation-",
        env: {
          ARCEEAI_API_KEY: otherKey,
          OPENAI_API_KEY: unaffectedKey,
          UNRESOLVED_LOCAL_ARCEE: undefined,
        },
      },
      async (state) => {
        await state.writeJson(
          "agents/main/agent/auth-profiles.json",
          apiKeyStore("arcee", { key: "synthetic-legacy-key" }),
        );
        const agentDir = state.agentDir("worker");
        await mkdir(agentDir, { recursive: true });
        writePersistedAuthProfileStoreRaw(
          apiKeyStore(
            "arcee",
            secretRef
              ? { keyRef: { source: "env", provider: "default", id: "UNRESOLVED_LOCAL_ARCEE" } }
              : { key: localKey },
          ),
          agentDir,
        );
        const baseUrl = "https://openrouter.ai/api/v1";
        const config = { models: { providers: { arcee: { baseUrl, models: [] } } } };
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
          const credential = await resolve();
          expect(
            credential === (provider === "arcee" ? localKey : unaffectedKey),
            "returned credential belongs to the selected account",
          ).toBe(true);
        }
        expect(fallback).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["local", "shared"])(
    "keeps imported %s credentials fenced until lifecycle clear",
    async (owner) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "auth-import-fence-" },
        async (state) => {
          const agentDir = state.agentDir("worker");
          await mkdir(agentDir, { recursive: true });
          const ownerDir = owner === "local" ? agentDir : undefined;
          const legacyPath = `agents/${owner === "local" ? "worker" : "main"}/agent/auth-profiles.json`;
          const importedKey = "synthetic-imported-key";
          const legacy = apiKeyStore("arcee", { key: importedKey });
          const legacyFile = await state.writeJson(legacyPath, legacy);
          writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, ownerDir);
          const baseUrl = "https://openrouter.ai/api/v1";
          const config = { models: { providers: { arcee: { baseUrl, models: [] } } } };
          const storage = AuthStorage.forAgent(agentDir, config);
          const fallback = vi.fn(() => "synthetic-other-account-key");
          storage.setFallbackResolver(fallback);
          expect(() => assertAuthProfileMigrationReady(ownerDir)).toThrow(
            "requires legacy credential migration",
          );

          // A raw write plus archive models another process's Doctor; this process keeps its fence.
          writePersistedAuthProfileStoreRaw(legacy, ownerDir);
          await rename(legacyFile, `${legacyFile}.migrated`);
          storage.reload();
          await expect(storage.getApiKey("arcee", { baseUrl })).rejects.toMatchObject({
            code: "AUTH_PROFILE_MIGRATION_REQUIRED",
          });
          expect(fallback).not.toHaveBeenCalled();

          clearAuthProfileMigrationDiagnostics();
          storage.reload();
          expect(
            (await storage.getApiKey("arcee", { baseUrl })) === importedKey,
            "lifecycle reload admits imported credential",
          ).toBe(true);

          if (owner === "shared") {
            const localKey = "synthetic-new-local-key";
            storage.set("arcee", { type: "api_key", key: localKey });
            expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual({
              version: 1,
              profiles: { "arcee:default": { type: "api_key", provider: "arcee", key: localKey } },
            });
            writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
            await state.writeJson(legacyPath, legacy);
            expect(() => assertAuthProfileMigrationReady()).toThrow(
              "requires legacy credential migration",
            );
            expect(
              (await storage.getApiKey("arcee", { baseUrl })) === localKey,
              "a local write changes the credential owner",
            ).toBe(true);
          }
        },
      );
    },
  );

  it("preserves distinct owners for identical imported credential bytes", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "auth-import-provenance-",
        env: { UNRESOLVED_IMPORTED_ARCEE: undefined },
      },
      async (state) => {
        const agentDir = state.agentDir("worker");
        await mkdir(agentDir, { recursive: true });
        const key = "synthetic-same-account-bytes";
        const legacy = apiKeyStore("arcee", { key });
        const legacyFile = await state.writeJson("agents/main/agent/auth-profiles.json", legacy);
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
        expect(() => assertAuthProfileMigrationReady()).toThrow(
          "requires legacy credential migration",
        );
        writePersistedAuthProfileStoreRaw(apiKeyStore("arcee", { key }));
        await rename(legacyFile, `${legacyFile}.migrated`);
        writePersistedAuthProfileStoreRaw(legacy, agentDir);
        const baseUrl = "https://openrouter.ai/api/v1";
        const config = { models: { providers: { arcee: { baseUrl, models: [] } } } };
        const fallback = vi.fn(() => "synthetic-other-account-key");
        const resolve = async () => {
          const storage = AuthStorage.forAgent(agentDir, config);
          storage.setFallbackResolver(fallback);
          return await storage.getApiKey("arcee", { baseUrl });
        };
        expect(
          (await resolve()) === key,
          "identical credential bytes retain their distinct owners",
        ).toBe(true);
        expect(fallback).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects imported credentials across a pending unresolved-Ref reload", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "auth-import-ref-race-",
        env: { UNRESOLVED_IMPORTED_ARCEE: undefined },
      },
      async (state) => {
        const agentDir = state.agentDir("worker");
        await mkdir(agentDir, { recursive: true });
        const imported = apiKeyStore("arcee", { key: "synthetic-imported-key" });
        const legacyFile = await state.writeJson("agents/main/agent/auth-profiles.json", imported);
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
        expect(() => assertAuthProfileMigrationReady()).toThrow(
          "requires legacy credential migration",
        );
        writePersistedAuthProfileStoreRaw(imported);
        await rename(legacyFile, `${legacyFile}.migrated`);
        const baseUrl = "https://openrouter.ai/api/v1";
        const storage = AuthStorage.forAgent(agentDir, {
          models: { providers: { arcee: { baseUrl, models: [] } } },
        });
        const fallback = vi.fn(() => "synthetic-other-account-key");
        storage.setFallbackResolver(fallback);
        const pending = storage.getApiKey("arcee", { baseUrl });
        writePersistedAuthProfileStoreRaw(
          apiKeyStore("arcee", {
            keyRef: { source: "env", provider: "default", id: "UNRESOLVED_IMPORTED_ARCEE" },
          }),
        );
        storage.reload();
        await expect(pending).rejects.toMatchObject({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" });
        expect(fallback).not.toHaveBeenCalled();
      },
    );
  });

  it("revalidates the selected owner after another reload changes the view", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "auth-selected-owner-" },
      async (state) => {
        const agentDir = state.agentDir("worker");
        await mkdir(agentDir, { recursive: true });
        const original = apiKeyStore("arcee", { key: "synthetic-shared-key" });
        await state.writeJson("agents/main/agent/auth-profiles.json", original);
        writePersistedAuthProfileStoreRaw(original);
        const baseUrl = "https://openrouter.ai/api/v1";
        const storage = AuthStorage.forAgent(agentDir, {
          models: { providers: { arcee: { baseUrl, models: [] } } },
        });
        const pending = storage.getApiKey("arcee", { baseUrl });
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
        expect(() => assertAuthProfileMigrationReady()).toThrow(
          "requires legacy credential migration",
        );
        const localKey = "synthetic-new-local-key";
        writePersistedAuthProfileStoreRaw(apiKeyStore("arcee", { key: localKey }), agentDir);
        storage.reload();
        await expect(pending).rejects.toMatchObject({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" });
        expect(
          (await storage.getApiKey("arcee", { baseUrl })) === localKey,
          "new requests retain the local owner",
        ).toBe(true);
      },
    );
  });

  it.each([
    { provider: "openai", blocked: false },
    { provider: "openrouter", blocked: true },
  ])("bounds an imported $provider credential's ambiguous realm", async ({ provider, blocked }) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "auth-import-realm-" },
      async (state) => {
        const agentDir = state.agentDir("worker");
        await mkdir(agentDir, { recursive: true });
        const legacyFile = await state.writeJson(
          "agents/main/agent/auth-profiles.json",
          apiKeyStore("arcee", { key: "synthetic-legacy-key" }),
        );
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
        expect(() => assertAuthProfileMigrationReady()).toThrow(
          "requires legacy credential migration",
        );
        const key = "synthetic-new-account-key";
        writePersistedAuthProfileStoreRaw(apiKeyStore(provider, { key }));
        await rename(legacyFile, `${legacyFile}.migrated`);
        const storage = AuthStorage.forAgent(agentDir, {});
        const result = storage.getApiKey(provider);
        if (blocked) {
          await expect(result).rejects.toMatchObject({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" });
        } else {
          expect((await result) === key, "unrelated canonical credential remains usable").toBe(
            true,
          );
        }
      },
    );
  });
});
