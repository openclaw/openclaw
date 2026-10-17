import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Model } from "../../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshot, type OAuthCredential } from "../../auth-profiles.js";
import { testing as externalAuthTesting } from "../../auth-profiles/external-auth.test-support.js";
import { clearAuthProfileMigrationDiagnostics } from "../../auth-profiles/legacy-source-diagnostic.js";
import { writePersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import type { AgentHarness } from "../../harness/types.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import * as modelRuntime from "../model.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";

const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null),
);

vi.mock("../../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));

const subscriptionModel: Model = makeProviderModelFixture({
  id: "gpt-5.6-luna",
  name: "Auth pin model",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  maxTokens: 1_024,
});
const platformModel: Model = {
  ...subscriptionModel,
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};

const openClawHarness: AgentHarness = {
  id: "openclaw",
  label: "OpenClaw fixture",
  supports: () => ({ supported: true }),
  runAttempt: async () => {
    throw new Error("Auth preparation must not execute a model turn");
  },
};

function modelConfig(model: Model, overrides: Partial<ModelProviderConfig> = {}): OpenClawConfig {
  return {
    models: {
      providers: { [model.provider]: { baseUrl: model.baseUrl, models: [], ...overrides } },
    },
  };
}

let state: OpenClawTestState;
let agentDir: string;
let stores: ReturnType<typeof modelRuntime.createEmptyAgentDiscoveryStores>;

async function prepare(
  initialModel: Model,
  config: OpenClawConfig,
  runParams: Partial<Parameters<typeof prepareEmbeddedRunAuthPlan>[0]["runParams"]> = {},
  resolveModel: (cfg?: OpenClawConfig) => Model = () => initialModel,
) {
  let model = initialModel;
  let harness = openClawHarness;
  // Mock discovery only; store loading and auth preparation retain their real owners.
  vi.spyOn(modelRuntime, "resolveModelAsync").mockImplementation(
    async (provider, id, _dir, cfg) => ({
      ...stores,
      logicalRef: { provider, model: id },
      model: resolveModel(cfg),
    }),
  );
  const prepared = await withPluginRuntimeGenerationScope(
    { metadataSnapshot: createPluginMetadataSnapshotFixture() },
    () =>
      prepareEmbeddedRunAuthPlan({
        assertCurrent: () => {},
        runParams: {
          sessionId: "auth-session",
          runId: "auth-run",
          workspaceDir: state.workspaceDir,
          prompt: "Auth preparation only",
          timeoutMs: 5_000,
          config,
          ...runParams,
        },
        provider: model.provider,
        modelId: model.id,
        model,
        agentDir,
        workspaceDir: state.workspaceDir,
        nativeModelOwned: false,
        ...stores,
        getAgentHarness: () => harness,
        setAgentHarness: (next) => {
          harness = next;
        },
        getRuntimeModel: () => model,
        getEffectiveModel: () => model,
        applyResolvedRuntimeModel: (next) => {
          model = next;
        },
        selectHarnessForPreparedAttempts: () => openClawHarness,
      }),
  );
  return { prepared, model };
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-auth-pin-",
    env: { OPENAI_API_KEY: "platform-api-key" },
  });
  agentDir = state.agentDir();
  stores = modelRuntime.createEmptyAgentDiscoveryStores();
  await state.writeAuthProfiles({ version: 1, profiles: {} });
  readCodexCliCredentialsCachedMock.mockReset().mockReturnValue({
    type: "oauth",
    provider: "openai",
    access: "codex-access-token",
    refresh: "codex-refresh-token",
    expires: Date.now() + 30 * 60_000,
  });
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
});

afterEach(async () => {
  clearAuthProfileMigrationDiagnostics();
  clearRuntimeAuthProfileStoreSnapshot(agentDir);
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  readCodexCliCredentialsCachedMock.mockReset();
  vi.restoreAllMocks();
  await state.cleanup();
});

it("prepares a LiteLLM turn while Anthropic credentials await migration", async () => {
  await state.writeJson("agents/main/agent/auth-profiles.json", {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "legacy-key" },
    },
  });
  writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
  const model: Model = {
    ...platformModel,
    provider: "litellm",
    id: "chat",
    name: "Chat",
    api: "openai-completions",
    baseUrl: "https://litellm.example.test/v1",
  };
  const config = modelConfig(model, { apiKey: "litellm-key" });
  const { prepared } = await prepare(model, config);
  expect(prepared.preparedAuthAttempts[0]).toMatchObject({
    kind: "direct",
    plan: { providerForAuth: "litellm", selectedAuthMode: "api-key" },
  });
});

it.each([
  [undefined, false, ["openai:selected", "openai:backup"]],
  [false, false, ["openai:selected"]],
  [false, true, ["openai:selected"]],
] as const)(
  "prepares permitted credentials with fallback=%s and configured backup=%s",
  async (allowAuthProfileFallback, configuredBackup, profileIds) => {
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:selected": { type: "api_key", provider: "openai", key: "selected-key" },
          "openai:backup": { type: "api_key", provider: "openai", key: "backup-key" },
        },
        order: { openai: ["openai:backup", "openai:selected"] },
      },
      agentDir,
    );
    const model = platformModel;
    const config = modelConfig(
      model,
      configuredBackup
        ? { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } }
        : {},
    );
    const { prepared } = await prepare(model, config, {
      authProfileId: "openai:selected",
      authProfileIdSource: "user",
      allowAuthProfileFallback,
    });

    expect(prepared.preparedAuthAttempts.map((attempt) => attempt.profileId)).toEqual(profileIds);
    expect(prepared.activePreparedAuthPlan.forwardedAuthProfileCandidateIds).toEqual(profileIds);
    expect(Object.keys(prepared.attemptAuthProfileStore.profiles).toSorted()).toEqual([
      "openai:backup",
      "openai:selected",
    ]);
  },
);

it.each([true, false])(
  "uses host API-key auth without importing Codex OAuth (pin=%s)",
  async (pin) => {
    const config = modelConfig(subscriptionModel, {
      ...(pin ? { auth: "api-key" } : {}),
      baseUrl: "",
    });
    const { prepared, model } = await prepare(subscriptionModel, config, {}, (cfg) =>
      cfg?.models?.providers?.openai?.api === "openai-responses"
        ? platformModel
        : subscriptionModel,
    );

    expect(prepared.preparedAuthAttempts[0]).toMatchObject({
      kind: "direct",
      plan: { selectedAuthMode: "api-key", modelRoute: { authRequirement: "api-key" } },
    });
    expect(prepared.attemptAuthProfileStore.profiles["openai:default"]).toBeUndefined();
    expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
    expect(model).toEqual(platformModel);
  },
);
