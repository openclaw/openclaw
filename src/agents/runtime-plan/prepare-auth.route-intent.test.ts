import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { configFor } from "../model-auth.fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

function authStore(apiKeyProfile: string, oauthProfile: string) {
  return createAuthProfileStoreFixture({
    [apiKeyProfile]: createApiKeyCredential("openai", "fixture-key"),
    [oauthProfile]: createOAuthRefreshCredential(),
  });
}

function billingConfig(primary: string, apiProfile: string, oauthProfile: string): OpenClawConfig {
  return {
    agents: { defaults: { model: primary, heartbeat: { model: "openai/gpt-5.4-mini" } } },
    auth: {
      profiles: {
        [apiProfile]: { provider: "openai", mode: "api_key" },
        [oauthProfile]: { provider: "openai", mode: "oauth" },
      },
    },
    ...configFor("openai", "https://api.openai.com/v1", { api: "openai-completions" }),
  };
}
type PrepareParams = Parameters<typeof prepareAgentRuntimeAuth>[0];
function underAmbient(
  snapshot: Parameters<typeof withPluginMetadataSnapshotScope>[0],
  params: Pick<PrepareParams, "provider" | "metadataSnapshot"> & Partial<PrepareParams>,
) {
  const config = params.config ?? {};
  const prepare = () =>
    prepareAgentRuntimeAuth({
      modelId: "model",
      env: {},
      authProfileStore: createAuthProfileStoreFixture({}),
      ...params,
      config,
    });
  return withPluginMetadataSnapshotScope(snapshot, prepare, { config, trustConfigIdentity: true });
}

it.each([
  ["metered@openai:platform", "codex", true, false],
  ["gpt-5.5@openai:platform", "openclaw", false, false],
  ["metered@openai:platform", "codex", false, true],
] as const)(
  "preserves the API route inherited from %s (runtime: %s, metadata: %s, observed: %s)",
  (primary, runtime, profileMetadata, observedResponses) => {
    const config = billingConfig(primary, "openai:platform", "openai:chatgpt");
    config.agents!.entries = { assistant: {} };
    config.agents!.defaults!.models = {
      "openai/gpt-5.5": { alias: "metered", agentRuntime: { id: runtime } },
    };
    if (!profileMetadata) {
      config.auth = undefined;
    }
    if (observedResponses) {
      config.models = undefined;
    }
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      env: {},
      config,
      agentId: "assistant",
      ...(observedResponses
        ? { modelApi: "openai-responses", modelBaseUrl: "https://api.openai.com/v1" }
        : {}),
      authProfileStore: authStore("openai:platform", "openai:chatgpt"),
    });
    expect(prepared.plan).toMatchObject({
      forwardedAuthProfileId: "openai:platform",
      modelRoute: { authRequirement: "api-key" },
    });
    expect(config.agents?.defaults?.model).toBe(primary);
  },
);
it.each(["provider-profile", "auth-order", "env-fallback", "provider-auth-with-env"] as const)(
  "preparation and availability preserve the same billing choice for %s",
  (choice) => {
    const hasEnvironmentKey = choice === "env-fallback" || choice === "provider-auth-with-env";
    const env = hasEnvironmentKey ? { OPENAI_API_KEY: "synthetic-environment-key" } : {};
    const subscription = choice === "env-fallback";
    const profileId = subscription ? "openai:chatgpt-default" : "openai:default";
    const authRequirement = subscription ? "subscription" : "api-key";
    const config = billingConfig(
      hasEnvironmentKey ? "openai/gpt-5.5" : "openai/gpt-5.5@openai:chatgpt-default",
      "openai:default",
      "openai:chatgpt-default",
    );
    if (choice === "auth-order") {
      config.auth!.order = { openai: ["openai:default", "openai:chatgpt-default"] };
    }
    Object.assign(
      config.models!.providers!.openai!,
      choice === "provider-auth-with-env" ? { auth: "api-key" } : {},
      choice === "provider-profile" ? { apiKey: "openai:default" } : {},
    );
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
    expect(prepared).toMatchObject({
      forwardedAuthProfileId: profileId,
      modelRoute: { authRequirement },
    });
    expect(available).toMatchObject({
      availability: true,
      selectedProfileId: profileId,
      selectedRoute: { authRequirement },
    });
  },
);

function metadata(owner: string) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: owner, providerAuthAliases: { "fixture-alias": owner } }],
  });
}

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
  const prepared = underAmbient(snapshot("AMBIENT_PROVIDER_KEY"), {
    provider: "fixture-provider",
    env: available ? { SELECTED_PROVIDER_KEY: "synthetic" } : { AMBIENT_PROVIDER_KEY: "synthetic" },
    metadataSnapshot: snapshot("SELECTED_PROVIDER_KEY"),
  });

  expect(prepared.attempts[0]?.kind).toBe(available ? "direct" : "implicit");
  expect(prepared.plan.credentialSource).toEqual(
    available
      ? { kind: "direct", evidence: "environment", authorization: "ambient" }
      : { kind: "none" },
  );
});

it.each(["user-link", "binding", "empty"] as const)(
  "selects the prepared owner for %s profiles despite ambient aliases",
  (selection) => {
    const empty = selection === "empty";
    const profileId = empty ? "fixture:exact" : "fixture:selected";
    const config: OpenClawConfig =
      selection === "binding" ? configFor("fixture-alias", "", { apiKey: "fixture:selected" }) : {};
    const prepared = underAmbient(metadata("ambient-auth"), {
      provider: "fixture-alias",
      config,
      metadataSnapshot: empty ? createPluginMetadataSnapshotFixture() : metadata("selected-auth"),
      authProfileStore: createAuthProfileStoreFixture({
        "fixture:ambient": createApiKeyCredential("ambient-auth", "synthetic-ambient"),
        [profileId]: createApiKeyCredential(
          empty ? "fixture-alias" : "selected-auth",
          empty ? "synthetic-exact" : "synthetic-selected",
        ),
      }),
      ...(selection === "user-link"
        ? { sessionAuthProfileId: "fixture:selected", sessionAuthProfileSource: selection }
        : {}),
    });

    if (!empty) {
      expect(prepared.plan).toMatchObject({
        providerForAuth: "selected-auth",
        forwardedAuthProfileId: "fixture:selected",
      });
    }
    expect(prepared.plan.forwardedAuthProfileCandidateIds).toEqual([profileId]);
    expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual([profileId]);
  },
);
