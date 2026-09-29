import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { maybeCompactAgentHarnessSession } from "./compaction.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import type { AgentHarness } from "./types.js";

const forbiddenHostAuth = vi.hoisted(() => () => {
  throw new Error("Plugin-owned compaction must not resolve host credentials or models");
});

vi.mock("../model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: forbiddenHostAuth,
  ensureAuthProfileStoreWithoutExternalProfiles: forbiddenHostAuth,
  getApiKeyForModelCore: forbiddenHostAuth,
}));
vi.mock("../embedded-agent-runner/model.js", () => ({
  resolveModelAsync: forbiddenHostAuth,
}));
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" }),
}));

let state: OpenClawTestState;
let generation: ReturnType<typeof createModelGenerationFixture>;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "compaction-plugin-auth" });
  resetModelGenerationFixtureState();
  generation = createModelGenerationFixture({
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    config: {},
    label: "compaction-plugin-auth",
    provider: "openai",
    requestProvider: "openai",
    modelId: "host-model",
    runtimeApi: "openai-responses",
    runtimeBaseUrl: "https://api.openai.com/v1",
  });
  publishCurrentModelGeneration(generation);
});

afterEach(async () => {
  clearAgentHarnesses();
  resetModelGenerationFixtureState();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

describe("plugin-owned harness compaction auth", () => {
  it("replaces a supplied host API-key plan before handing compaction to the plugin", async () => {
    const hostPlan: AgentRuntimeAuthPlan = {
      providerForAuth: "openai",
      modelId: "host-model",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: "openai:host-profile",
      forwardedAuthProfileSource: "user",
      selectedAuthMode: "api-key",
      modelRoute: {
        provider: "openai",
        modelId: "host-model",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    };
    const result = { ok: true, compacted: true } as const;
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async (params) => {
      expect(params.runtimeAuthPlan).toEqual({
        providerForAuth: "openai",
        modelId: "host-model",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "configured-plugin",
        credentialSource: { kind: "none" },
      });
      expect({
        apiKey: params.resolvedApiKey,
        model: params.runtimeModel,
        profileId: params.authProfileId,
        profileSource: params.authProfileIdSource,
      }).toEqual({
        apiKey: undefined,
        model: undefined,
        profileId: undefined,
        profileSource: undefined,
      });
      return result;
    });
    registerAgentHarness(
      {
        id: "configured-plugin",
        label: "Configured plugin fixture",
        authBootstrap: "plugin",
        supports: (ctx) =>
          ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: async () => {
          throw new Error("Compaction must not start inference");
        },
        compact,
      },
      { ownerPluginId: "configured-plugin" },
    );

    await expect(
      maybeCompactAgentHarnessSession(
        {
          sessionId: "plugin-auth-session",
          sessionKey: "agent:main:main",
          sessionFile: state.path("session.jsonl"),
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(),
          config: {},
          provider: "openai",
          model: "host-model",
          agentHarnessId: "configured-plugin",
          runtimeAuthPlan: hostPlan,
          runtimeModel: generation.resolveDynamicModel(),
          resolvedApiKey: "synthetic-host-api-key",
          authProfileId: "openai:host-profile",
          authProfileIdSource: "user",
        },
        {
          preparedModelRuntime: generation.preparedModelRuntime,
          sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined },
        },
      ),
    ).resolves.toEqual(result);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
