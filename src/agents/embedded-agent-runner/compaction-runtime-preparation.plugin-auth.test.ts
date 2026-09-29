import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../harness/types.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";

const mocks = vi.hoisted(() => ({
  ensurePlugin: vi.fn(async () => {}),
  selectHarness: vi.fn(),
  selectPreparedHarness: vi.fn(),
  ensureStore: vi.fn(),
  ensureStoreWithoutExternal: vi.fn(),
  prepareAuth: vi.fn(),
  profileScopedMetadata: vi.fn(),
  resolveModel: vi.fn(),
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: mocks.ensurePlugin,
}));
vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: mocks.selectHarness,
  selectAgentHarnessForPreparedModelProviders: mocks.selectPreparedHarness,
}));
vi.mock("../harness/policy.js", () => ({ resolveAgentHarnessPolicy: vi.fn() }));
vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore: mocks.ensureStore,
  ensureAuthProfileStoreWithoutExternalProfiles: mocks.ensureStoreWithoutExternal,
}));
vi.mock("../runtime-plan/prepare-auth.js", () => ({
  prepareAgentRuntimeAuth: mocks.prepareAuth,
}));
vi.mock("../runtime-plan/credential-scoped-model.js", () => ({
  providerUsesCredentialScopedModelMetadata: mocks.profileScopedMetadata,
  resolveReusableRuntimeModelAuth: vi.fn(),
}));
vi.mock("./model-resolution.js", () => ({ resolveTieredModel: mocks.resolveModel }));

import {
  prepareCompactionHarnessAuth,
  prepareCompactionModel,
} from "./compaction-runtime-preparation.js";

const pluginHarness: AgentHarness = {
  id: "plugin-auth",
  label: "Plugin auth",
  authBootstrap: "plugin",
  supports: () => ({ supported: true }),
  runAttempt: async () => {
    throw new Error("not used");
  },
};
const pluginPlan: AgentRuntimeAuthPlan = {
  providerForAuth: "openai",
  authProfileProviderForAuth: "openai",
  harnessAuthProvider: "plugin-auth",
  modelId: "fixture-model",
  credentialSource: { kind: "none" },
};
const params = {
  provider: "openai",
  modelId: "fixture-model",
  agentDir: "/test/agent",
  workspaceDir: "/test/workspace",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectHarness.mockReturnValue(pluginHarness);
  mocks.selectPreparedHarness.mockReturnValue(pluginHarness);
  mocks.prepareAuth.mockReturnValue({
    plan: pluginPlan,
    attempts: [{ kind: "implicit", plan: pluginPlan }],
  });
  mocks.ensureStore.mockImplementation(() => {
    throw new Error("provider auth store is unavailable");
  });
  mocks.ensureStoreWithoutExternal.mockImplementation(() => {
    throw new Error("provider auth store is unavailable");
  });
  mocks.profileScopedMetadata.mockImplementation(() => {
    throw new Error("credential-scoped metadata is unavailable");
  });
});

describe("plugin-owned compaction authentication", () => {
  it("selects plugin authentication before resolving model metadata", async () => {
    const resolution = { model: { id: "fixture-model" } };
    mocks.resolveModel.mockImplementation(async (input) => {
      expect(input.harnessAuthBootstrap).toBe("plugin");
      return { provider: input.provider, resolution };
    });

    const result = await prepareCompactionModel({
      ...params,
      runtimeProvider: "openai",
      pluginRegistry: undefined,
    });

    expect(result.resolution).toBe(resolution);
    expect(mocks.selectHarness).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", modelId: "fixture-model" }),
    );
  });

  it("replans inherited provider authentication under the plugin owner", async () => {
    const result = await prepareCompactionHarnessAuth({
      ...params,
      authProfileId: "openai:previous",
      reusableRuntimeAuthPlan: {
        ...pluginPlan,
        harnessAuthProvider: undefined,
        forwardedAuthProfileId: "openai:previous",
        credentialSource: { kind: "profile" },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      runtimeAuthProfileStore: { version: 1, profiles: {} },
      runtimeAuthPreparation: { plan: pluginPlan },
      providerUsesProfileScopedModelMetadata: false,
    });
    expect(mocks.prepareAuth).toHaveBeenCalledWith(
      expect.objectContaining({ harnessAuthBootstrap: "plugin", harnessId: "plugin-auth" }),
    );
  });

  it("retains inherited provider auth when the harness uses the shared credential path", async () => {
    const harness = { ...pluginHarness, authBootstrap: undefined };
    const store = { version: 1, profiles: {} };
    mocks.selectPreparedHarness.mockReturnValue(harness);
    mocks.ensureStore.mockReturnValue(store);
    mocks.profileScopedMetadata.mockReturnValue(true);
    const plan = { ...pluginPlan, harnessAuthProvider: undefined };

    const result = await prepareCompactionHarnessAuth({
      ...params,
      reusableRuntimeAuthPlan: plan,
    });

    expect(result).toMatchObject({
      ok: true,
      runtimeAuthProfileStore: store,
      runtimeAuthPreparation: { plan },
      providerUsesProfileScopedModelMetadata: true,
    });
    expect(mocks.ensureStore).toHaveBeenCalledWith("/test/agent", {
      profileId: undefined,
      externalCliProviderIds: ["openai"],
      allowKeychainPrompt: false,
    });
  });
});
