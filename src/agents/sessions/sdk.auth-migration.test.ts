import { mkdir } from "node:fs/promises";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { Model } from "../../llm/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearAuthProfileMigrationDiagnostics } from "../auth-profiles/legacy-source-diagnostic.js";
import { writePersistedAuthProfileStoreRaw } from "../auth-profiles/sqlite.js";
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
});
