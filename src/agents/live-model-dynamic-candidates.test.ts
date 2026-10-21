import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  prepareProviderDynamicModel: vi.fn(),
  resolveProviderModernModelRef: vi.fn(),
  runProviderDynamicModel: vi.fn(),
}));

const normalizeDiscoveredAgentModelMock = vi.hoisted(() => vi.fn((value: unknown) => value));

vi.mock("./model-discovery-normalize.js", () => ({
  normalizeDiscoveredAgentModel: normalizeDiscoveredAgentModelMock,
}));

vi.mock("../plugins/provider-runtime.js", () => providerRuntimeMocks);

import { appendLiveModelCandidates } from "./test-helpers/live-model-dynamic-candidates.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const REGISTRY = { find: () => undefined } as never;
const DYNAMIC_PROVIDER = "dynamic-test-provider";
type CandidateOptions = Parameters<typeof appendLiveModelCandidates>[0];

function model(provider: string, id: string): Model {
  return makeProviderModelFixture({
    id,
    provider,
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    contextWindow: 128_000,
  });
}

const config: OpenClawConfig = {
  models: {
    providers: {
      [DYNAMIC_PROVIDER]: {
        api: "openai-completions",
        baseUrl: "https://configured.example/v1",
        models: [],
      },
    },
  },
};
const agentDir = "/tmp/openclaw-agent";
const ref = { provider: DYNAMIC_PROVIDER, id: "glm-5" };
function candidates(overrides: Partial<CandidateOptions> = {}) {
  return appendLiveModelCandidates({
    models: [],
    agentDir,
    modelRegistry: REGISTRY,
    refs: [ref],
    ...overrides,
  });
}

describe("appendLiveModelCandidates", () => {
  beforeEach(() => {
    normalizeDiscoveredAgentModelMock.mockClear();
    providerRuntimeMocks.prepareProviderDynamicModel.mockReset().mockResolvedValue(undefined);
    providerRuntimeMocks.resolveProviderModernModelRef.mockReset().mockReturnValue(undefined);
    providerRuntimeMocks.runProviderDynamicModel.mockReset().mockReturnValue(undefined);
  });

  it("materializes prioritized refs from provider dynamic model hooks", async () => {
    const resolveDynamicModel = vi.fn<NonNullable<CandidateOptions["resolveDynamicModel"]>>(
      (params) =>
        params.context.provider === DYNAMIC_PROVIDER && params.context.modelId === "glm-5"
          ? model(DYNAMIC_PROVIDER, "glm-5")
          : undefined,
    );
    const prepareDynamicModel = vi.fn<NonNullable<CandidateOptions["prepareDynamicModel"]>>(
      async () => undefined,
    );
    const normalizeModel = vi.fn<NonNullable<CandidateOptions["normalizeModel"]>>((entry) => entry);
    const result = await candidates({
      models: [model("anthropic", "claude-sonnet-4-6")],
      config,
      resolveDynamicModel,
      prepareDynamicModel,
      normalizeModel,
      refs: [{ provider: "anthropic", id: "claude-sonnet-4-6" }, ref],
    });

    expect(result.added.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      `${DYNAMIC_PROVIDER}/glm-5`,
    ]);
    expect(result.models.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      `${DYNAMIC_PROVIDER}/glm-5`,
    ]);
    for (const hook of [prepareDynamicModel, resolveDynamicModel]) {
      expect(hook).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          provider: DYNAMIC_PROVIDER,
          context: expect.objectContaining({
            agentDir,
            modelId: "glm-5",
            modelRegistry: REGISTRY,
            provider: DYNAMIC_PROVIDER,
            providerConfig: config.models?.providers?.[DYNAMIC_PROVIDER],
          }),
        }),
      );
    }
    expect(normalizeModel).toHaveBeenCalledWith(
      expect.objectContaining(ref),
      "/tmp/openclaw-agent",
    );
  });

  it.each(["prepared", "resolved"])(
    "materializes a %s model through default hooks",
    async (mode) => {
      const preparedModel = model(DYNAMIC_PROVIDER, "glm-5");
      if (mode === "prepared") {
        providerRuntimeMocks.prepareProviderDynamicModel.mockResolvedValue(preparedModel);
      } else {
        providerRuntimeMocks.runProviderDynamicModel.mockImplementation((params) =>
          params.context.provider === DYNAMIC_PROVIDER && params.context.modelId === "glm-5"
            ? preparedModel
            : undefined,
        );
      }
      const options =
        mode === "prepared" ? {} : { config, workspaceDir: "/tmp/openclaw-workspace" };
      const result = await candidates(options);
      expect(result.added).toEqual([preparedModel]);
      expect(providerRuntimeMocks.prepareProviderDynamicModel).toHaveBeenCalledTimes(1);
      expect(providerRuntimeMocks.runProviderDynamicModel).toHaveBeenCalledTimes(
        mode === "prepared" ? 0 : 1,
      );
      expect(normalizeDiscoveredAgentModelMock).toHaveBeenCalledWith(preparedModel, agentDir, {
        config: options.config,
        workspaceDir: options.workspaceDir,
      });
    },
  );
});
