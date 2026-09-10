import { mkdir, rename } from "node:fs/promises";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { Model } from "../../llm/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "../auth-profiles/legacy-source-diagnostic.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const legacyOpenRouter = {
  version: 1,
  profiles: {
    "openrouter:default": {
      type: "api_key",
      provider: "openrouter",
      key: "synthetic-legacy-key",
    },
  },
};

afterEach(() => {
  clearAuthProfileMigrationDiagnostics();
  vi.restoreAllMocks();
});

describe("SDK migration guard endpoint context", () => {
  it.each<{
    route: string;
    baseUrl: string;
    configuredBaseUrl?: string;
    blocked: boolean;
    localCredential?: boolean;
  }>([
    {
      route: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      configuredBaseUrl: "https://openrouter.ai/api/v1",
      blocked: true,
    },
    {
      route: "direct Arcee",
      baseUrl: "https://api.arcee.ai/api/v1",
      configuredBaseUrl: "https://api.arcee.ai/api/v1",
      blocked: false,
    },
    {
      route: "missing endpoint",
      baseUrl: "https://openrouter.ai/api/v1",
      blocked: true,
    },
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
    {
      route: "direct Arcee local account override",
      baseUrl: "https://api.arcee.ai/api/v1",
      configuredBaseUrl: "https://openrouter.ai/api/v1",
      localCredential: true,
      blocked: false,
    },
  ])(
    "resolves $route before provider dispatch",
    async ({ route, baseUrl, configuredBaseUrl, blocked, localCredential }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "sdk-auth-endpoint-" },
        async (state) => {
          await state.writeJson(
            `agents/${localCredential ? "main" : "worker"}/agent/auth-profiles.json`,
            legacyOpenRouter,
          );
          const agentDir = state.agentDir("worker");
          await mkdir(agentDir, { recursive: true });
          const localKey = "synthetic-local-account-key";
          writePersistedAuthProfileStoreRaw(
            {
              version: 1,
              profiles: localCredential
                ? {
                    "arcee:default": { type: "api_key", provider: "arcee", key: localKey },
                  }
                : {},
            },
            agentDir,
          );
          if (configuredBaseUrl) {
            setRuntimeConfigSnapshot({
              models: { providers: { arcee: { baseUrl: configuredBaseUrl, models: [] } } },
            });
          }
          const model: Model = {
            id: "synthetic-model",
            name: "Synthetic model",
            api: "openai-completions",
            provider: "arcee",
            baseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 1000,
          };
          const { session } = await createAgentSession({
            agentDir,
            model,
            resourceLoader: createResourceLoader(),
            settingsManager: SettingsManager.inMemory(),
            sessionManager: SessionManager.inMemory(),
            noTools: "all",
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
                auth.ok && auth.apiKey === (localCredential ? localKey : credential),
                "direct account credential selected",
              ).toBe(true);
            }
            console.info(
              `[auth migration proof] route=${route}; decision=${decision}; providerDispatches=${providerIo.mock.calls.length}; credential=[redacted]`,
            );
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
    { name: "local key across a shared Arcee refusal", secretRef: false, provider: "arcee" },
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
        await state.writeJson("agents/main/agent/auth-profiles.json", {
          version: 1,
          profiles: {
            "arcee:default": { type: "api_key", provider: "arcee", key: "synthetic-legacy-key" },
          },
        });
        const agentDir = state.agentDir("worker");
        await mkdir(agentDir, { recursive: true });
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: {
              "arcee:default": {
                type: "api_key",
                provider: "arcee",
                ...(secretRef
                  ? { keyRef: { source: "env", provider: "default", id: "UNRESOLVED_LOCAL_ARCEE" } }
                  : { key: localKey }),
              },
            },
          },
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
          const legacy = {
            version: 1,
            profiles: {
              "arcee:default": {
                type: "api_key",
                provider: "arcee",
                key: "synthetic-imported-key",
              },
            },
          };
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
            (await storage.getApiKey("arcee", { baseUrl })) ===
              legacy.profiles["arcee:default"].key,
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

  it.each([false, true])(
    "preserves import ownership and Ref validation (SecretRef: %s)",
    async (secretRef) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "auth-import-provenance-",
          env: { UNRESOLVED_IMPORTED_ARCEE: undefined },
        },
        async (state) => {
          const agentDir = state.agentDir("worker");
          await mkdir(agentDir, { recursive: true });
          const profile = {
            type: "api_key",
            provider: "arcee",
            key: "synthetic-same-account-bytes",
          };
          const legacy = { version: 1, profiles: { "arcee:default": profile } };
          const legacyFile = await state.writeJson("agents/main/agent/auth-profiles.json", legacy);
          writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
          expect(() => assertAuthProfileMigrationReady()).toThrow(
            "requires legacy credential migration",
          );
          writePersistedAuthProfileStoreRaw({
            version: 1,
            profiles: {
              "arcee:default": secretRef
                ? {
                    type: "api_key",
                    provider: "arcee",
                    keyRef: { source: "env", provider: "default", id: "UNRESOLVED_IMPORTED_ARCEE" },
                  }
                : profile,
            },
          });
          await rename(legacyFile, `${legacyFile}.migrated`);
          if (!secretRef) {
            writePersistedAuthProfileStoreRaw(legacy, agentDir);
          }
          const baseUrl = "https://openrouter.ai/api/v1";
          const config = { models: { providers: { arcee: { baseUrl, models: [] } } } };
          const fallback = vi.fn(() => "synthetic-other-account-key");
          const resolve = async () => {
            const storage = AuthStorage.forAgent(agentDir, config);
            storage.setFallbackResolver(fallback);
            return await storage.getApiKey("arcee", { baseUrl });
          };
          if (secretRef) {
            await expect(resolve()).rejects.toThrow(
              "requires the active secrets runtime to materialize SecretRef credentials",
            );
          } else {
            expect(
              (await resolve()) === profile.key,
              "identical credential bytes retain their distinct owners",
            ).toBe(true);
          }
          expect(fallback).not.toHaveBeenCalled();
        },
      );
    },
  );

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
        const imported = {
          version: 1,
          profiles: {
            "arcee:default": { type: "api_key", provider: "arcee", key: "synthetic-imported-key" },
          },
        };
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
        writePersistedAuthProfileStoreRaw({
          version: 1,
          profiles: {
            "arcee:default": {
              type: "api_key",
              provider: "arcee",
              keyRef: { source: "env", provider: "default", id: "UNRESOLVED_IMPORTED_ARCEE" },
            },
          },
        });
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
        const original = {
          version: 1,
          profiles: {
            "arcee:default": { type: "api_key", provider: "arcee", key: "synthetic-shared-key" },
          },
        };
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
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: { "arcee:default": { type: "api_key", provider: "arcee", key: localKey } },
          },
          agentDir,
        );
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
        const legacyFile = await state.writeJson("agents/main/agent/auth-profiles.json", {
          version: 1,
          profiles: {
            "arcee:default": { type: "api_key", provider: "arcee", key: "synthetic-legacy-key" },
          },
        });
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} });
        expect(() => assertAuthProfileMigrationReady()).toThrow(
          "requires legacy credential migration",
        );
        const key = "synthetic-new-account-key";
        writePersistedAuthProfileStoreRaw({
          version: 1,
          profiles: { [`${provider}:default`]: { type: "api_key", provider, key } },
        });
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
