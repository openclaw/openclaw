import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

function authStore(apiKeyProfile: string, oauthProfile: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [apiKeyProfile]: { type: "api_key", provider: "openai", key: "fixture-key" },
      [oauthProfile]: {
        type: "oauth",
        provider: "openai",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
      },
    },
  };
}

describe("prepared primary route inheritance", () => {
  it.each([
    { primary: "metered@openai:platform", runtime: "codex" },
    { primary: "gpt-5.5@openai:platform", runtime: "openclaw", profileMetadata: false },
    {
      primary: "metered@openai:platform",
      runtime: "codex",
      profileMetadata: false,
      observedResponses: true,
    },
  ])(
    "preserves the API route inherited from $primary (metadata: $profileMetadata)",
    ({ primary, runtime, profileMetadata, observedResponses }) => {
      const config: OpenClawConfig = {
        agents: {
          entries: { assistant: {} },
          defaults: {
            model: primary,
            models: {
              "openai/gpt-5.5": { alias: "metered", agentRuntime: { id: runtime } },
            },
            heartbeat: { model: "openai/gpt-5.4-mini" },
          },
        },
        auth:
          profileMetadata === false
            ? undefined
            : {
                profiles: {
                  "openai:platform": { provider: "openai", mode: "api_key" },
                  "openai:chatgpt": { provider: "openai", mode: "oauth" },
                },
              },
        models: observedResponses
          ? undefined
          : {
              providers: {
                openai: {
                  api: "openai-completions",
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
      };
      const prepared = prepareAgentRuntimeAuth({
        config,
        agentId: "assistant",
        provider: "openai",
        modelId: "gpt-5.4-mini",
        ...(observedResponses
          ? { modelApi: "openai-responses", modelBaseUrl: "https://api.openai.com/v1" }
          : {}),
        authProfileStore: authStore("openai:platform", "openai:chatgpt"),
        env: {},
      });
      expect(prepared.plan).toMatchObject({
        forwardedAuthProfileId: "openai:platform",
        modelRoute: { authRequirement: "api-key" },
      });
      expect(config.agents?.defaults?.model).toBe(primary);
    },
  );
});

describe("explicit authentication before inherited billing intent", () => {
  it.each(["provider-profile", "auth-order", "env-fallback", "provider-auth-with-env"] as const)(
    "preparation and availability preserve the same billing choice for %s",
    (choice) => {
      const hasEnvironmentKey = choice === "env-fallback" || choice === "provider-auth-with-env";
      const env = hasEnvironmentKey ? { OPENAI_API_KEY: "synthetic-environment-key" } : {};
      const subscription = choice === "env-fallback";
      const expected = {
        profileId: subscription ? "openai:chatgpt-default" : "openai:default",
        authRequirement: subscription ? "subscription" : "api-key",
      };
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: hasEnvironmentKey ? "openai/gpt-5.5" : "openai/gpt-5.5@openai:chatgpt-default",
            heartbeat: { model: "openai/gpt-5.4-mini" },
          },
        },
        auth: {
          profiles: {
            "openai:default": { provider: "openai", mode: "api_key" },
            "openai:chatgpt-default": { provider: "openai", mode: "oauth" },
          },
          ...(choice === "auth-order"
            ? { order: { openai: ["openai:default", "openai:chatgpt-default"] } }
            : {}),
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              models: [],
              ...(choice === "provider-auth-with-env" ? { auth: "api-key" } : {}),
              ...(choice === "provider-profile" ? { apiKey: "openai:default" } : {}),
            },
          },
        },
      };
      const store = authStore("openai:default", "openai:chatgpt-default");
      const prepared = prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        config,
        authProfileStore: store,
        env,
      }).plan;
      const available = createModelAuthAvailabilityResolver({
        cfg: config,
        authStore: store,
        env,
      }).evaluateModelAuth("openai", { modelId: "gpt-5.4-mini" });
      expect(available.availability).toBe(true);
      expect({
        preparation: {
          profileId: prepared.forwardedAuthProfileId,
          authRequirement: prepared.modelRoute?.authRequirement,
        },
        availability: {
          profileId: available.selectedProfileId,
          authRequirement: available.selectedRoute?.authRequirement,
        },
      }).toEqual({ preparation: expected, availability: expected });
    },
  );
});

function metadata(owner: string) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: owner, providerAuthAliases: { "fixture-alias": owner } }],
  });
}

describe("prepared auth metadata ownership", () => {
  it.each([true, false])("uses selected environment evidence (available: %s)", (available) => {
    const snapshot = (envVar: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-owner",
            providers: ["fixture-provider"],
            setup: {
              requiresRuntime: false,
              providers: [{ id: "fixture-provider", envVars: [envVar] }],
            },
          },
        ],
      });
    const config = {};
    const prepared = withPluginMetadataSnapshotScope(
      snapshot("AMBIENT_PROVIDER_KEY"),
      () =>
        prepareAgentRuntimeAuth({
          provider: "fixture-provider",
          modelId: "model",
          config,
          env: available
            ? { SELECTED_PROVIDER_KEY: "synthetic" }
            : { AMBIENT_PROVIDER_KEY: "synthetic" },
          metadataSnapshot: snapshot("SELECTED_PROVIDER_KEY"),
          authProfileStore: { version: 1, profiles: {} },
        }),
      { config, trustConfigIdentity: true },
    );

    expect(prepared.attempts[0]?.kind).toBe(available ? "direct" : "implicit");
    expect(prepared.plan.credentialSource).toEqual(
      available
        ? { kind: "direct", evidence: "environment", authorization: "ambient" }
        : { kind: "none" },
    );
  });

  it.each(["user-link", "binding"] as const)(
    "selects the prepared owner for %s profiles despite ambient aliases",
    (selection) => {
      const config: OpenClawConfig =
        selection === "binding"
          ? {
              models: {
                providers: {
                  "fixture-alias": { baseUrl: "", models: [], apiKey: "fixture:selected" },
                },
              },
            }
          : {};
      const prepare = () =>
        prepareAgentRuntimeAuth({
          provider: "fixture-alias",
          modelId: "model",
          config,
          env: {},
          metadataSnapshot: metadata("selected-auth"),
          authProfileStore: createAuthProfileStoreFixture({
            "fixture:ambient": createApiKeyCredential("ambient-auth", "synthetic-ambient"),
            "fixture:selected": createApiKeyCredential("selected-auth", "synthetic-selected"),
          }),
          ...(selection === "user-link"
            ? { sessionAuthProfileId: "fixture:selected", sessionAuthProfileSource: selection }
            : {}),
        });
      const prepared = withPluginMetadataSnapshotScope(metadata("ambient-auth"), prepare, {
        config,
        trustConfigIdentity: true,
      });

      expect(prepared.plan).toMatchObject({
        providerForAuth: "selected-auth",
        forwardedAuthProfileId: "fixture:selected",
        forwardedAuthProfileCandidateIds: ["fixture:selected"],
      });
      expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["fixture:selected"]);
    },
  );

  it("treats an empty prepared selection as authoritative", () => {
    const config = {};
    const prepared = withPluginMetadataSnapshotScope(
      metadata("ambient-auth"),
      () =>
        prepareAgentRuntimeAuth({
          provider: "fixture-alias",
          modelId: "model",
          config,
          env: {},
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          authProfileStore: createAuthProfileStoreFixture({
            "fixture:exact": createApiKeyCredential("fixture-alias", "synthetic-exact"),
            "fixture:ambient": createApiKeyCredential("ambient-auth", "synthetic-ambient"),
          }),
        }),
      { config, trustConfigIdentity: true },
    );

    expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["fixture:exact"]);
    expect(prepared.plan.forwardedAuthProfileCandidateIds).toEqual(["fixture:exact"]);
  });
});
