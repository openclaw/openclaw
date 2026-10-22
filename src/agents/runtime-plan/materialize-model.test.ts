import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelProviderConfig } from "../../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { configFor } from "../model-auth.fixtures.test-support.js";
import {
  platformModel,
  platformRoute,
  subscriptionModel,
  subscriptionPlan as createSubscriptionPlan,
} from "./auth-fixtures.test-support.js";
import { createPreparedRuntimeModelMaterializer } from "./credential-scoped-model.js";
import { materializePreparedRuntimeModel, type RuntimeRouteModel } from "./materialize-model.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

const plan = createSubscriptionPlan();
const routeModel = (
  id: string,
  api: NonNullable<ModelProviderConfig["api"]>,
  baseUrl: string,
  provider = "openai",
) => ({
  provider,
  id,
  api,
  baseUrl,
});

type MaterializeParams<M extends RuntimeRouteModel> = Parameters<
  typeof materializePreparedRuntimeModel<M>
>[0];
function expectModel<M extends RuntimeRouteModel>(
  params: Partial<MaterializeParams<M>> & Pick<MaterializeParams<M>, "resolveModel">,
) {
  return expect(
    materializePreparedRuntimeModel({ plan, provider: "openai", modelId: "gpt-5.5", ...params }),
  );
}

function apiPlan(
  modelId: string,
  overrides: Partial<AgentRuntimeAuthPlan> = {},
  baseUrl = platformModel.baseUrl,
): AgentRuntimeAuthPlan {
  return {
    ...plan,
    selectedAuthMode: "api-key",
    ...overrides,
    modelRoute: {
      ...platformRoute,
      modelId,
      baseUrl,
    },
  };
}

describe("materializePreparedRuntimeModel", () => {
  const retired = routeModel(
    "gpt-retirement-fixture",
    "openai-chatgpt-responses",
    "https://subscription.example/v1",
  );
  const apiSibling = routeModel(retired.id, "openai-responses", "https://api.example/v1");
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "retirement-owner",
        providers: ["openai"],
        enabledByDefault: true,
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: retired.id,
              retirement: {},
              when: { baseUrlHosts: ["subscription.example"], providerConfigApiIn: [retired.api] },
            },
          ],
        },
      },
    ],
  });
  it.each(["matching", "resolved", "route-less", "api-sibling"] as const)(
    "validates retirement on the final %s route",
    async (mode) => {
      const final = mode === "api-sibling" ? apiSibling : retired;
      const resolveModel = vi.fn(async () => ({ model: final }));
      const configured = mode === "route-less" || mode === "api-sibling" ? retired : apiSibling;
      const result = expectModel({
        plan:
          mode === "route-less"
            ? { providerForAuth: "openai", authProfileProviderForAuth: "openai" }
            : mode === "api-sibling"
              ? apiPlan(retired.id, {}, apiSibling.baseUrl)
              : {
                  ...plan,
                  modelRoute: {
                    ...plan.modelRoute!,
                    modelId: retired.id,
                    baseUrl: retired.baseUrl,
                  },
                },
        modelId: retired.id,
        config: configFor("openai", configured.baseUrl, { api: configured.api }),
        metadataSnapshot,
        ...(mode === "resolved" ? {} : { model: retired }),
        resolveModel,
      });
      if (mode === "api-sibling") {
        await result.resolves.toBe(apiSibling);
      } else {
        await result.rejects.toMatchObject({
          reason: "model_not_found",
          message: expect.stringContaining("openclaw doctor --fix"),
        });
      }
      expect(resolveModel).toHaveBeenCalledTimes(
        mode === "resolved" || mode === "api-sibling" ? 1 : 0,
      );
    },
  );

  it.each([true, false])("re-resolves profile-scoped metadata (routed: %s)", async (routed) => {
    const model = routed
      ? subscriptionModel
      : routeModel(
          "private-model",
          "anthropic-messages",
          "https://router.example.test",
          "clawrouter",
        );
    const authPlan: AgentRuntimeAuthPlan = routed
      ? { ...plan, forwardedAuthProfileId: "openai:backup" }
      : {
          providerForAuth: "clawrouter",
          authProfileProviderForAuth: "clawrouter",
          modelId: model.id,
          forwardedAuthProfileId: "clawrouter:backup",
          selectedAuthMode: "api-key",
        };
    const rematerialized = { ...model, name: "backup-profile-model" };
    const resolveModel = vi.fn(async () => ({ model: rematerialized }));
    await expectModel({
      provider: model.provider,
      modelId: model.id,
      plan: authPlan,
      model,
      ...(routed ? {} : { config: {} }),
      forceResolve: true,
      resolveModel,
    }).resolves.toBe(rematerialized);
    expect(resolveModel).toHaveBeenCalledWith(
      routed
        ? expect.objectContaining({ authProfileId: "openai:backup" })
        : { config: {}, authProfileId: "clawrouter:backup", authProfileMode: "api_key" },
    );
  });

  it.each([
    { name: "different transport", model: platformModel },
    {
      name: "different model on the same transport",
      model: { ...subscriptionModel, id: "gpt-5.4" },
    },
  ])("re-resolves $name with the selected route and exact auth mode", async ({ model }) => {
    const resolveModel = vi.fn<MaterializeParams<typeof subscriptionModel>["resolveModel"]>(
      async () => ({ model: subscriptionModel }),
    );
    await expectModel({
      config: { models: { providers: {} } },
      model,
      resolveModel,
    }).resolves.toBe(subscriptionModel);
    expect(resolveModel).toHaveBeenCalledOnce();
    const request = resolveModel.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      authProfileId: "openai:subscription",
      authProfileMode: "token",
    });
    expect(request?.config.models?.providers?.openai).toMatchObject({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it.each([
    {
      modelId: "gpt-5.4-nano",
      model: routeModel("gpt-5.4-nano", "openai-completions", "https://api.openai.com"),
      rejected: true,
    },
    { modelId: "gpt-5.4-codex", model: { ...platformModel, id: "gpt-5.4" }, rejected: false },
  ])(
    "validates the final API tuple for $modelId (rejected: $rejected)",
    async ({ modelId, model, rejected }) => {
      const resolveModel = vi.fn();
      const result = expectModel({
        plan: apiPlan(
          modelId,
          rejected ? { forwardedAuthProfileId: "openai:key", selectedAuthMode: "api_key" } : {},
        ),
        modelId,
        model,
        resolveModel,
        rejectMismatchedModel: rejected,
      });
      if (rejected) {
        await result.rejects.toThrow("does not match its prepared api-key route");
      } else {
        await result.resolves.toBe(model);
      }
      expect(resolveModel).not.toHaveBeenCalled();
    },
  );

  it("rejects mismatched targets and mismatched resolved tuples", async () => {
    await expectModel({
      modelId: "gpt-5.6",
      resolveModel: vi.fn(),
    }).rejects.toThrow(/does not match target/u);

    await expectModel({
      resolveModel: vi.fn(async () => ({ model: platformModel })),
    }).rejects.toThrow(/prepared subscription route/u);
  });
});

describe("generation route-model memo", () => {
  const routedModel = routeModel(
    "gpt-5.5",
    "openai-chatgpt-responses",
    "https://chatgpt.com/backend-api/codex",
  );
  type Resolution = { model?: typeof routedModel | null; error?: string };
  let memo: Map<string, Promise<typeof routedModel>>;
  const resolveModel = vi.fn<() => Promise<Resolution>>();
  const run = (
    options: Partial<
      Parameters<typeof createPreparedRuntimeModelMaterializer<typeof routedModel>>[0]
    > = {},
  ) =>
    createPreparedRuntimeModelMaterializer({
      provider: "openai",
      modelId: "gpt-5.5",
      getModel: () => ({ ...routedModel, baseUrl: "https://api.openai.com/v1" }),
      nativeModelOwned: false,
      providerUsesProfileScopedModelMetadata: true,
      generationRouteModelMemo: memo,
      resolveModel,
      ...options,
    });
  const materialize = (
    overrides: Partial<AgentRuntimeAuthPlan> = {},
    options: Parameters<typeof run>[0] = {},
  ) => run(options).materialize(createSubscriptionPlan(overrides));
  beforeEach(() => {
    memo = new Map();
    resolveModel.mockReset().mockResolvedValue({ model: routedModel });
  });

  it("coalesces pending resolution across runs with value-identical plans", async () => {
    const pending = createDeferred<{ model: typeof routedModel }>();
    resolveModel.mockImplementation(() => pending.promise);
    const first = materialize();
    const second = materialize();
    expect(resolveModel).toHaveBeenCalledTimes(1);
    pending.resolve({ model: routedModel });
    await expect(Promise.all([first, second])).resolves.toEqual([routedModel, routedModel]);
  });

  it("keeps delimiter-containing route identities as distinct memo entries", async () => {
    const instance = run();
    await instance.materialize(
      createSubscriptionPlan({
        forwardedAuthProfileId: "openai:subscription\u0001token",
        selectedAuthMode: undefined,
      }),
    );
    await instance.materialize(createSubscriptionPlan());
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "provider-owned dynamic refresh", options: { providerOwnsDynamicModelRefresh: true } },
    { name: "no generation memo", options: { generationRouteModelMemo: undefined } },
  ])("resolves each run with $name", async ({ options }) => {
    await materialize({}, options);
    await materialize({}, options);
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("never pins a rejected resolution for the generation", async () => {
    resolveModel.mockResolvedValueOnce({ error: "transient provider failure" });
    await expect(materialize()).rejects.toThrow("transient provider failure");
    expect(memo.size).toBe(0);
    await expect(materialize()).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("covers route-less plans so non-OpenAI providers share resolutions too", async () => {
    await expect(materialize({ modelRoute: undefined })).resolves.toBe(routedModel);
    await expect(materialize({ modelRoute: undefined })).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps each run's base model private (native ownership %s)",
    async (nativeModelOwned) => {
      if (nativeModelOwned) {
        await materialize();
      }
      const baseA = { ...routedModel };
      const baseB = { ...routedModel };
      const resolveBase = (base: typeof routedModel) =>
        materialize(
          nativeModelOwned
            ? {}
            : { forwardedAuthProfileId: undefined, selectedAuthMode: undefined },
          {
            getModel: () => base,
            nativeModelOwned,
            providerUsesProfileScopedModelMetadata: nativeModelOwned,
          },
        );
      await expect(resolveBase(baseA)).resolves.toBe(baseA);
      await expect(resolveBase(baseB)).resolves.toBe(baseB);
      expect(resolveModel).toHaveBeenCalledTimes(nativeModelOwned ? 1 : 0);
      expect(memo.size).toBe(nativeModelOwned ? 1 : 0);
    },
  );

  it("does not let an evicted promise's late rejection remove its replacement", async () => {
    const pending = createDeferred<{ model: typeof routedModel }>();
    resolveModel.mockImplementationOnce(() => pending.promise);
    const turn = (profile: number) =>
      materialize({ forwardedAuthProfileId: `openai:profile-${profile}` });
    const first = expect(turn(0)).rejects.toThrow("retired resolution failed");
    for (let profile = 1; profile <= 64; profile += 1) {
      await turn(profile);
    }
    const replacement = { ...routedModel };
    resolveModel.mockResolvedValueOnce({ model: replacement });
    await expect(turn(0)).resolves.toBe(replacement);
    pending.reject(new Error("retired resolution failed"));
    await first;
    expect(memo.size).toBe(64);
    await expect(turn(0)).resolves.toBe(replacement);
    expect(resolveModel).toHaveBeenCalledTimes(66);
  });
});
