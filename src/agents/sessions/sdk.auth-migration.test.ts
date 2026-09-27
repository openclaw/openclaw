import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { snapshotFiles } from "../../infra/state-migrations.caller-mode.test-helpers.js";
import { autoMigrateLegacyState } from "../../infra/state-migrations.doctor.js";
import type { Model } from "../../llm/types.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
} from "../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
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
import { ModelRegistry } from "./model-registry.js";
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

describe("SDK installation ownership", () => {
  it.each([
    { configuredOwner: "worker", doctor: false },
    { configuredOwner: "worker", doctor: true },
    { configuredOwner: "main", doctor: true },
  ])(
    "preserves existing standalone sessions (configured owner: $configuredOwner, Doctor: $doctor)",
    async ({ configuredOwner, doctor }) => {
      await withOpenClawTestState(
        { label: "sdk-legacy-owner", layout: "split", agentEnv: "clear" },
        async (state) => {
          vi.spyOn(os, "homedir").mockReturnValue(state.home);
          const legacyDir = path.join(state.home, ".openclaw", "agent");
          const options = {
            cwd: state.workspaceDir,
            model: testModel,
            resourceLoader: createResourceLoader(),
            settingsManager: SettingsManager.inMemory(),
            authStorage: AuthStorage.inMemory(),
            modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
          };
          const existing = await createAgentSession({ ...options, agentDir: legacyDir });
          const original = expectDefined(
            existing.session.sessionManager.getSessionTarget(),
            "legacy SDK target",
          );
          existing.session.dispose();
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest();
          expect(inspectOpenClawAgentDatabaseOwner(original.storePath)).toEqual({
            status: "owned",
            agentId: "main",
          });

          const binary = process.platform === "win32" ? "fd.exe" : "fd";
          await mkdir(path.join(legacyDir, "bin"));
          await writeFile(path.join(legacyDir, "bin", binary), "installed SDK tool");
          await writeFile(
            path.join(legacyDir, "models.json"),
            JSON.stringify({
              providers: {
                [testModel.provider]: {
                  baseUrl: testModel.baseUrl,
                  api: testModel.api,
                  models: [testModel],
                },
              },
            }),
          );

          const before = snapshotFiles(legacyDir);
          const cfg = {
            agents: { entries: { [configuredOwner]: {} } },
            plugins: { enabled: false },
          };
          await state.writeConfig(cfg);
          if (doctor) {
            const result = await autoMigrateLegacyState({
              cfg,
              homedir: () => state.home,
              doctorOnlyStateMigrations: true,
              legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
            });
            expect(
              result.stepReceipts.find((entry) => entry.outcome === "refused"),
            ).toBeUndefined();
            const receipt = result.stepReceipts.find((entry) => entry.id === "agent-dir");
            if (configuredOwner === "worker") {
              expect(receipt).toMatchObject({
                outcome: "deferred",
                deferred: [
                  {
                    reason: "owner-mismatch",
                    recordedOwner: "main",
                    configuredOwner,
                    path: legacyDir,
                  },
                ],
              });
              expect(receipt?.warnings).toEqual(
                expect.arrayContaining([expect.stringContaining("Keep using the existing store")]),
              );
              expect(snapshotFiles(legacyDir)).toEqual(before);
            } else {
              expect(receipt).toMatchObject({
                outcome: "deferred",
                sqliteFamilies: [
                  {
                    database: original.storePath,
                    files: expect.arrayContaining([original.storePath]),
                    destination: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
                    outcome: "deferred",
                    reason: "sqlite-family",
                  },
                ],
              });
              expect(snapshotFiles(legacyDir)).toEqual(before);
            }
            await expect(
              access(
                path.join(state.agentDir(configuredOwner), ".legacy-agent-dir-migration.json"),
              ),
            ).rejects.toMatchObject({ code: "ENOENT" });
            await closeOpenClawAgentDatabasesAsync();
            closeOpenClawAgentDatabasesForTest();
          }

          const { session } = await createAgentSession(options);
          try {
            const target = expectDefined(
              session.sessionManager.getSessionTarget(),
              "resolved SDK target",
            );
            expect(target.agentId).toBe("main");
            const activeDir = legacyDir;
            expect(target.storePath).toBe(original.storePath);
            const { ensureTool } = await import("../utils/tools-manager.js");
            await expect(ensureTool("fd", true)).resolves.toBe(path.join(activeDir, "bin", binary));
            const discovered = ModelRegistry.create(AuthStorage.inMemory());
            expect(discovered.find(testModel.provider, testModel.id)).toMatchObject({
              id: testModel.id,
            });
            const retained = { ...original, storePath: target.storePath, agentId: target.agentId };
            expect(loadSessionEntry(retained)).toMatchObject({ sessionId: original.sessionId });
            await expect(loadTranscriptEvents(retained)).resolves.toEqual(
              expect.arrayContaining([
                expect.objectContaining({ type: "session", id: original.sessionId }),
              ]),
            );
          } finally {
            session.dispose();
          }
        },
      );
    },
  );

  it.each(["legacy", "environment", "option"])(
    "creates a session with malformed config and a %s directory",
    async (selection) => {
      await withOpenClawTestState(
        { label: "sdk-invalid-config", agentEnv: "clear" },
        async (state) => {
          const agentDir =
            selection === "legacy"
              ? path.join(state.home, ".openclaw/agent")
              : state.statePath("selected-agent");
          vi.spyOn(os, "homedir").mockReturnValue(state.home);
          await mkdir(agentDir, { recursive: true });
          await writeFile(path.join(agentDir, "existing-state.txt"), "SDK state");
          await writeFile(state.configPath, "{broken config");
          const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
          const error = vi.spyOn(console, "error").mockImplementation(() => {});
          await withEnvAsync(
            { OPENCLAW_AGENT_DIR: selection === "environment" ? agentDir : undefined },
            async () => {
              const beforeEnv = { ...process.env };
              const { session } = await createAgentSession({
                ...(selection === "option" ? { agentDir } : {}),
                cwd: state.workspaceDir,
                model: testModel,
                resourceLoader: createResourceLoader(),
                settingsManager: SettingsManager.inMemory(),
              });
              try {
                expect(session.sessionManager.getSessionTarget()?.storePath).toBe(
                  path.join(agentDir, "openclaw-agent.sqlite"),
                );
                expect(await readFile(state.configPath, "utf8")).toBe("{broken config");
                expect(await readFile(path.join(agentDir, "existing-state.txt"), "utf8")).toBe(
                  "SDK state",
                );
                expect(process.env).toEqual(beforeEnv);
                expect(
                  warn.mock.calls.filter(([message]) =>
                    String(message).includes("default agent directory"),
                  ),
                ).toHaveLength(1);
                expect(error).not.toHaveBeenCalled();
              } finally {
                session.dispose();
              }
            },
          );
        },
      );
    },
  );

  it.each(["canonical", "custom"])(
    "keeps the implicit SDK session with its configured owner in a %s directory",
    async (layout) => {
      await withOpenClawTestState(
        { label: "sdk-install-owner", agentEnv: "clear" },
        async (state) => {
          const agentDir =
            layout === "custom" ? state.statePath("worker-state") : state.agentDir("worker");
          const homedir = vi.spyOn(os, "homedir").mockReturnValue(state.home);
          try {
            await state.writeConfig({
              agents: { entries: { worker: layout === "custom" ? { agentDir } : {} } },
              plugins: { enabled: false },
            });
            const { session } = await createAgentSession({
              cwd: state.workspaceDir,
              model: testModel,
              resourceLoader: createResourceLoader(),
              settingsManager: SettingsManager.inMemory(),
              modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
            });
            try {
              const target = expectDefined(session.sessionManager.getSessionTarget(), "SDK target");
              expect(target).toMatchObject({
                agentId: "worker",
                sessionKey: `agent:worker:sdk:${target.sessionId}`,
                storePath: path.join(agentDir, "openclaw-agent.sqlite"),
              });
              expect(inspectOpenClawAgentDatabaseOwner(target.storePath)).toMatchObject({
                status: "owned",
                agentId: "worker",
              });
              expect(loadSessionEntry(target)).toMatchObject({ sessionId: target.sessionId });
              await expect(loadTranscriptEvents(target)).resolves.toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ type: "session", id: target.sessionId }),
                ]),
              );
            } finally {
              session.dispose();
            }
          } finally {
            homedir.mockRestore();
          }
        },
      );
    },
  );
});
