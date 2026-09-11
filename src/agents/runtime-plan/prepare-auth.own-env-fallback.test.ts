import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withSetupCredentialAccess } from "../auth-profiles/setup-access.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./resolve-auth.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture-plugin",
      providers: ["fixture-api", "fixture-plan"],
      providerAuthAliases: { "fixture-plan": "fixture-api" },
      setup: {
        requiresRuntime: false,
        providers: [{ id: "fixture-api", envVars: ["FIXTURE_API_KEY"] }],
      },
    },
  ],
});
const model: Model = {
  provider: "fixture-api",
  id: "chat",
  name: "Chat",
  api: "openai-completions",
  baseUrl: "https://fixture.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const profileId = "fixture-api:saved";

function account(state: "healthy" | "expired" | "revoked"): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "token",
        provider: model.provider,
        token: "saved-account",
        expires: state === "expired" ? 1 : Date.now() + 60_000,
      },
    },
    ...(state === "revoked"
      ? {
          usageStats: {
            [profileId]: {
              disabledUntil: Date.now() + 60_000,
              disabledReason: "auth_permanent" as const,
            },
          },
        }
      : {}),
  };
}

describe("independently admitted provider environment fallback", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["healthy", "expired", "revoked"] as const)(
    "resolves the usable source and reports readiness for a %s saved account",
    async (state) => {
      vi.stubEnv("FIXTURE_API_KEY", "environment-account");
      const config: OpenClawConfig = {};
      const store = account(state);
      await withPluginMetadataSnapshotScope(
        metadataSnapshot,
        async () => {
          const prepared = prepareAgentRuntimeAuth({
            provider: model.provider,
            modelId: model.id,
            modelApi: model.api,
            modelBaseUrl: model.baseUrl,
            config,
            env: process.env,
            authProfileStore: store,
            metadataSnapshot,
            harnessId: "openclaw",
          });
          const resolved = await resolvePreparedRuntimeAuthAttempts({
            attempts: prepared.attempts,
            store,
            modelId: model.id,
            model,
            materializeModel: async ({ model: selected }) => selected,
            resolveAuth: ({ attempt, model: selected }) =>
              resolvePreparedRuntimeModelAuth({
                plan: attempt.plan,
                model: selected,
                cfg: config,
                store,
              }),
            errorMessage: "No usable account",
          });
          expect(resolved.auth.apiKey).toBe(
            state === "healthy" ? "saved-account" : "environment-account",
          );
          const readiness = createModelAuthAvailabilityResolver({
            cfg: config,
            authStore: store,
            metadataSnapshot,
            env: process.env,
          }).evaluateModelAuth(model.provider, { modelId: model.id });
          expect(readiness).toMatchObject({
            availability: true,
            evidence: state === "healthy" ? "profile" : "environment",
          });
          if (state !== "healthy") {
            expect(readiness.environmentVariable).toBe("FIXTURE_API_KEY");
          }
        },
        { config, trustConfigIdentity: true },
      );
    },
  );

  it("does not verify an unavailable setup replacement through the current environment account", async () => {
    const config: OpenClawConfig = {};
    const env = { FIXTURE_API_KEY: "environment-account" };
    const store = account("expired");
    const profile = store.profiles[profileId];
    if (!profile) {
      throw new Error("Expected the stored setup replacement fixture");
    }
    profile.setup = {
      replacement: true,
      modelRef: `${model.provider}/${model.id}`,
      configJson: "{}",
    };
    const prepare = () =>
      prepareAgentRuntimeAuth({
        provider: model.provider,
        modelId: model.id,
        config,
        env,
        authProfileStore: store,
        metadataSnapshot,
      });
    const available = () =>
      createModelAuthAvailabilityResolver({
        cfg: config,
        env,
        authStore: store,
        metadataSnapshot,
      }).resolveProviderAuthAvailability(model.provider);

    expect(prepare().attempts).toMatchObject([{ kind: "direct" }]);
    expect(available()).toBe(true);
    await withSetupCredentialAccess({ profileId }, async () => {
      expect(prepare).toThrow("No usable bound auth profile");
      expect(available()).toBe(false);
    });
    expect(prepare().attempts).toMatchObject([{ kind: "direct" }]);
    expect(available()).toBe(true);
  });

  it.each(["user", "user-link"] as const)(
    "keeps a healthy %s pin on saved accounts when an own environment key exists",
    async (sessionAuthProfileSource) => {
      vi.stubEnv("FIXTURE_API_KEY", "environment-account");
      const config: OpenClawConfig = {};
      const store = account("healthy");
      const backupProfileId = "fixture-api:backup";
      store.profiles[backupProfileId] = {
        type: "token",
        provider: model.provider,
        token: "backup-account",
        expires: Date.now() + 60_000,
      };
      await withPluginMetadataSnapshotScope(
        metadataSnapshot,
        async () => {
          const prepared = prepareAgentRuntimeAuth({
            provider: model.provider,
            modelId: model.id,
            modelApi: model.api,
            modelBaseUrl: model.baseUrl,
            config,
            env: process.env,
            authProfileStore: store,
            metadataSnapshot,
            sessionAuthProfileId: profileId,
            sessionAuthProfileSource,
          });
          expect(prepared.attempts).toHaveLength(2);
          expect(prepared.attempts).toMatchObject([
            { kind: "profile", profileId },
            { kind: "profile", profileId: backupProfileId },
          ]);
          vi.stubEnv("FIXTURE_API_KEY", undefined);
          for (const [index, attempt] of prepared.attempts.entries()) {
            expect(attempt.plan.boundEnvVar).toBeUndefined();
            const resolved = await resolvePreparedRuntimeModelAuth({
              plan: attempt.plan,
              model,
              cfg: config,
              store,
            });
            expect(resolved.auth.apiKey).toBe(index === 0 ? "saved-account" : "backup-account");
          }
        },
        { config, trustConfigIdentity: true },
      );
    },
  );

  it.each(["pin", "order", "shared-alias"] as const)(
    "does not use the environment key to bypass %s selection",
    (selection) => {
      vi.stubEnv("FIXTURE_API_KEY", "environment-account");
      const config: OpenClawConfig =
        selection === "order" ? { auth: { order: { "fixture-api": [profileId] } } } : {};
      const provider = selection === "shared-alias" ? "fixture-plan" : model.provider;
      expect(() =>
        prepareAgentRuntimeAuth({
          provider,
          modelId: model.id,
          config,
          env: process.env,
          authProfileStore: account("expired"),
          metadataSnapshot,
          ...(selection === "pin"
            ? { sessionAuthProfileId: profileId, sessionAuthProfileSource: "user" }
            : {}),
        }),
      ).toThrow();
      expect(
        createModelAuthAvailabilityResolver({
          cfg: config,
          authStore: account("expired"),
          metadataSnapshot,
          env: process.env,
          requestedProviderIds: [provider],
        }).resolveProviderAuthAvailability(
          provider,
          selection === "pin" ? { pinnedProfileId: profileId } : {},
        ),
      ).toBe(false);
    },
  );
});
