import { expect, it, vi } from "vitest";
import { GCP_VERTEX_CREDENTIALS_MARKER } from "../model-auth-markers.js";
import { authStore, oauth, platformModel } from "./auth-fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./resolve-auth.js";

const setupRegistryMocks = vi.hoisted(() => ({
  resolvePluginSetupProviderCore: vi.fn(() => ({
    resolveConfigApiKey: () => "gcp-vertex-credentials",
  })),
}));

vi.mock("../model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
    setupProviderFallbackRefs: ["anthropic-vertex"],
  }),
}));

vi.mock("../../plugins/setup-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/setup-registry.js")>()),
  resolvePluginSetupProviderCore: setupRegistryMocks.resolvePluginSetupProviderCore,
}));

it("defers setup resolution until a prepared profile attempt fails", async () => {
  const profileId = "anthropic-vertex:missing";
  const config = {
    auth: { order: { "anthropic-vertex": [profileId] } },
  };
  const store = authStore(
    { [profileId]: oauth({ provider: "anthropic-vertex", expires: 0 }) },
    config.auth.order,
  );
  const prepared = prepareAgentRuntimeAuth({
    provider: "anthropic-vertex",
    modelId: "claude-sonnet-4-6",
    config,
    env: {},
    authProfileStore: store,
  });

  expect(setupRegistryMocks.resolvePluginSetupProviderCore).not.toHaveBeenCalled();
  expect(prepared.attempts).toMatchObject([
    { kind: "profile", profileId },
    {
      kind: "direct",
      allowAuthProfileFallback: false,
      requiresPriorProfileAttempt: true,
    },
  ]);

  const model = {
    ...platformModel,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic-vertex",
    api: "anthropic-messages",
    baseUrl: "https://example.invalid",
  };
  const resolved = await resolvePreparedRuntimeAuthAttempts({
    attempts: prepared.attempts,
    store,
    modelId: model.id,
    model,
    materializeModel: async ({ model: preparedModel }) => preparedModel,
    resolveAuth: async ({ attempt, model: preparedModel }) =>
      resolvePreparedRuntimeModelAuth({
        plan: attempt.plan,
        model: preparedModel,
        cfg: config,
        store,
      }),
    errorMessage: "prepared Anthropic Vertex auth failed",
  });

  expect(resolved.auth).toMatchObject({
    apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
    source: "gcloud adc",
    mode: "api-key",
  });
  expect(setupRegistryMocks.resolvePluginSetupProviderCore).toHaveBeenCalledOnce();
});
