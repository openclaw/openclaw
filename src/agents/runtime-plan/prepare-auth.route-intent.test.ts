import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture as metadataSnapshot } from "../../plugins/plugin-metadata.test-support.js";
import {
  createApiKeyCredential as apiKey,
  createAuthProfileStoreFixture as authStore,
  createOAuthRefreshCredential as oauth,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { configFor } from "../model-auth.fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

function billingFixture(primary: string, apiProfile: string, oauthProfile: string) {
  const config: OpenClawConfig = {
    agents: { defaults: { model: primary, heartbeat: { model: "openai/gpt-5.4-mini" } } },
    auth: {
      profiles: {
        [apiProfile]: { provider: "openai", mode: "api_key" },
        [oauthProfile]: { provider: "openai", mode: "oauth" },
      },
    },
    ...configFor("openai", "https://api.openai.com/v1", { api: "openai-completions" }),
  };
  return {
    provider: "openai",
    modelId: "gpt-5.4-mini",
    env: {},
    config,
    authProfileStore: authStore({
      [apiProfile]: apiKey("openai", "fixture-key"),
      [oauthProfile]: oauth(),
    }),
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
      authProfileStore: authStore({}),
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
    const fixture = billingFixture(primary, "openai:platform", "openai:chatgpt");
    const { config } = fixture;
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
      ...fixture,
      agentId: "assistant",
      ...(observedResponses
        ? { modelApi: "openai-responses", modelBaseUrl: "https://api.openai.com/v1" }
        : {}),
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
    const fixture = billingFixture(
      hasEnvironmentKey ? "openai/gpt-5.5" : "openai/gpt-5.5@openai:chatgpt-default",
      "openai:default",
      "openai:chatgpt-default",
    );
    const { config, authProfileStore } = fixture;
    if (choice === "auth-order") {
      config.auth!.order = { openai: ["openai:default", "openai:chatgpt-default"] };
    }
    Object.assign(
      config.models!.providers!.openai!,
      choice === "provider-auth-with-env" ? { auth: "api-key" } : {},
      choice === "provider-profile" ? { apiKey: "openai:default" } : {},
    );
    const prepared = prepareAgentRuntimeAuth({ ...fixture, env }).plan;
    const available = createModelAuthAvailabilityResolver({
      cfg: config,
      authStore: authProfileStore,
      env,
    }).evaluateModelAuth("openai", { modelId: "gpt-5.4-mini" });
    expect([
      prepared.forwardedAuthProfileId,
      prepared.modelRoute?.authRequirement,
      available.availability,
      available.selectedProfileId,
      available.selectedRoute?.authRequirement,
    ]).toEqual([profileId, authRequirement, true, profileId, authRequirement]);
  },
);

function metadata(owner: string) {
  return metadataSnapshot({
    plugins: [{ id: owner, providerAuthAliases: { "fixture-alias": owner } }],
  });
}

it.each([true, false])("uses selected environment evidence (available: %s)", (available) => {
  const snapshot = (envVar: string) =>
    metadataSnapshot({
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
      metadataSnapshot: empty ? metadataSnapshot() : metadata("selected-auth"),
      authProfileStore: authStore({
        "fixture:ambient": apiKey("ambient-auth", "synthetic-ambient"),
        [profileId]: apiKey(
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
