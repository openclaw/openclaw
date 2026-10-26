import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture as metadataSnapshot } from "../../plugins/plugin-metadata.test-support.js";
import {
  createApiKeyCredential as apiKey,
  createAuthProfileStoreFixture as authStore,
  createOAuthRefreshCredential as oauth,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { configFor } from "../model-auth.fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

function billingFixture(primary: string, apiId: string, oauthId: string) {
  const profile = (mode: "api_key" | "oauth") => ({ provider: "openai", mode });
  const config: OpenClawConfig = {
    agents: { defaults: { model: primary, heartbeat: { model: "openai/gpt-5.4-mini" } } },
    auth: { profiles: { [apiId]: profile("api_key"), [oauthId]: profile("oauth") } },
    ...configFor("openai", "https://api.openai.com/v1", { api: "openai-completions" }),
  };
  return {
    provider: "openai",
    modelId: "gpt-5.4-mini",
    env: {},
    config,
    authProfileStore: authStore({ [apiId]: apiKey("openai", "fixture-key"), [oauthId]: oauth() }),
  };
}
type PrepareParams = Parameters<typeof prepareAgentRuntimeAuth>[0];
function underAmbient(
  snapshot: Parameters<typeof withPluginMetadataSnapshotScope>[0],
  {
    config = {},
    ...input
  }: Pick<PrepareParams, "provider" | "metadataSnapshot"> & Partial<PrepareParams>,
) {
  const params = { modelId: "model", env: {}, authProfileStore: authStore({}), ...input, config };
  return withPluginMetadataSnapshotScope(snapshot, () => prepareAgentRuntimeAuth(params), {
    config,
    trustConfigIdentity: true,
  });
}

it.each([
  ["metered@openai:platform", "codex", true, false],
  ["gpt-5.5@openai:platform", "openclaw", false, false],
  ["metered@openai:platform", "codex", false, true],
] as const)(
  "inherits %s (%s, metadata=%s, observed=%s)",
  (primary, runtime, declared, observed) => {
    const fixture = billingFixture(primary, "openai:platform", "openai:chatgpt");
    const { config } = fixture;
    config.agents!.entries = { assistant: {} };
    config.agents!.defaults!.models = {
      "openai/gpt-5.5": { alias: "metered", agentRuntime: { id: runtime } },
    };
    config.auth = declared ? config.auth : undefined;
    config.models = observed ? undefined : config.models;
    const prepared = prepareAgentRuntimeAuth({
      ...fixture,
      agentId: "assistant",
      modelApi: observed ? "openai-responses" : undefined,
      modelBaseUrl: observed ? "https://api.openai.com/v1" : undefined,
    });
    expect(prepared.plan).toMatchObject({
      forwardedAuthProfileId: "openai:platform",
      modelRoute: { authRequirement: "api-key" },
    });
    expect(config.agents?.defaults?.model).toBe(primary);
  },
);

it("keeps explicit API billing ahead of ambient auth", () => {
  const fixture = billingFixture("openai/gpt-5.5", "openai:platform", "openai:chatgpt");
  fixture.config.models!.providers!.openai!.auth = "api-key";
  const { plan } = prepareAgentRuntimeAuth({
    ...fixture,
    env: { OPENAI_API_KEY: "synthetic-environment-key" },
  });
  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:platform",
    modelRoute: { authRequirement: "api-key" },
  });
});

function metadata(owner: string) {
  return metadataSnapshot({
    plugins: [{ id: owner, providerAuthAliases: { "fixture-alias": owner } }],
  });
}

it.each([true, false])("uses selected environment evidence (available: %s)", (available) => {
  const snapshot = (envVar: string) => {
    const id = "fixture-provider";
    const setup = { requiresRuntime: false, providers: [{ id, envVars: [envVar] }] };
    return metadataSnapshot({ plugins: [{ id: "fixture-owner", providers: [id], setup }] });
  };
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
  "isolates %s profiles from ambient aliases",
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
        [profileId]: apiKey(empty ? "fixture-alias" : "selected-auth", "synthetic-selected"),
      }),
      sessionAuthProfileId: selection === "user-link" ? profileId : undefined,
      sessionAuthProfileSource: selection === "user-link" ? selection : undefined,
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
