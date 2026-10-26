import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ metadata: vi.fn() }));

// mock-isolation: Keep provider alias tests independent of installed plugin metadata and registry state.
vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.metadata,
}));

import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { codexHarness, platformRoute, subscriptionRoute } from "./auth-fixtures.test-support.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";

const buildPlan = (params: Partial<Parameters<typeof buildAgentRuntimeAuthPlan>[0]>) =>
  buildAgentRuntimeAuthPlan({
    provider: "openai",
    authProfileProvider: "openai",
    config: {},
    sessionAuthProfileId: "openai:work",
    ...params,
  });

describe("buildAgentRuntimeAuthPlan", () => {
  it.each([
    { provider: undefined, forwarded: "arcee:default" },
    { provider: "", forwarded: undefined },
  ])("distinguishes an omitted credential provider from '$provider'", ({ provider, forwarded }) => {
    const plan = buildAgentRuntimeAuthPlan({
      provider: "arcee",
      authProfileProvider: provider,
      sessionAuthProfileId: "arcee:default",
      sessionAuthProfileSource: "user",
      providerAuthAliasesEnabled: false,
    });
    expect(plan.forwardedAuthProfileId).toBe(forwarded);
  });

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.metadata.mockReset().mockReturnValue({ index: { plugins: [] }, plugins: [] });
  });

  it.each([
    { label: "explicit flag", config: {}, providerAuthAliasesEnabled: false },
    { label: "plugin config", config: { plugins: { enabled: false } } },
  ])("does not load provider aliases disabled by $label", (params) => {
    mocks.metadata.mockImplementationOnce(() => {
      throw new Error("Disabled aliases must not load plugin metadata");
    });

    const plan = buildAgentRuntimeAuthPlan({
      provider: "fixture",
      authProfileProvider: "fixture",
      config: params.config,
      providerAuthAliasesEnabled: params.providerAuthAliasesEnabled,
    });

    expect(plan).toMatchObject({
      providerForAuth: "fixture",
      authProfileProviderForAuth: "fixture",
    });
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it("preserves the selected model route and locked profile source", () => {
    const plan = buildPlan({
      authProfileMode: "token",
      sessionAuthProfileSource: "user",
      modelRoute: subscriptionRoute,
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "openai:work",
      forwardedAuthProfileSource: "user",
      selectedAuthMode: "token",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      },
    });
  });

  it("does not forward profiles when the harness rejects host auth", () => {
    const plan = buildPlan({
      authProfileMode: "api_key",
      sessionAuthProfileSource: "auto",
      sessionAuthProfileCandidateIds: ["openai:work"],
      modelRoute: platformRoute,
      ...codexHarness,
      allowHarnessAuthProfileForwarding: false,
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.forwardedAuthProfileCandidateIds).toBeUndefined();
    expect(plan.selectedAuthMode).toBeUndefined();
  });
});
