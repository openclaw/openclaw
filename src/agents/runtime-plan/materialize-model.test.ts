import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
    modelRoute: { ...platformRoute, modelId, baseUrl },
  };
}

describe("materializePreparedRuntimeModel", () => {
  const retired = {
    ...subscriptionModel,
    id: "gpt-retirement-fixture",
    baseUrl: "https://subscription.example/v1",
  };
  const apiSibling = { ...platformModel, id: retired.id, baseUrl: "https://api.example/v1" };
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
  const retiredPlan = createSubscriptionPlan({
    modelRoute: { ...plan.modelRoute!, modelId: retired.id, baseUrl: retired.baseUrl },
  });
  it.each([
    ["matching", retiredPlan, retired],
    ["resolved", retiredPlan, undefined],
    ["route-less", { providerForAuth: "openai", authProfileProviderForAuth: "openai" }, retired],
    ["api-sibling", apiPlan(retired.id, {}, apiSibling.baseUrl), retired],
  ] as const)("validates retirement on the final %s route", async (mode, authPlan, model) => {
    const final = mode === "api-sibling" ? apiSibling : retired;
    const result = expectModel({
      plan: authPlan,
      modelId: retired.id,
      config: configFor("openai", retired.baseUrl, { api: retired.api }),
      metadataSnapshot,
      model,
      resolveModel: async () => ({ model: final }),
    });
    if (mode === "api-sibling") {
      await result.resolves.toBe(apiSibling);
    } else {
      await result.rejects.toMatchObject({
        reason: "model_not_found",
        message: expect.stringContaining("openclaw doctor --fix"),
      });
    }
  });

  it.each([true, false])("re-resolves profile-scoped metadata (routed: %s)", async (routed) => {
    const model = routed
      ? subscriptionModel
      : {
          ...platformModel,
          id: "private-model",
          api: "anthropic-messages" as const,
          baseUrl: "https://router.example.test",
          provider: "clawrouter",
        };
    const authPlan = createSubscriptionPlan({
      providerForAuth: model.provider,
      authProfileProviderForAuth: model.provider,
      modelId: model.id,
      modelRoute: routed ? plan.modelRoute : undefined,
      forwardedAuthProfileId: `${model.provider}:backup`,
      selectedAuthMode: routed ? "token" : "api-key",
    });
    const rematerialized = { ...model, name: "backup-profile-model" };
    const resolveModel = vi.fn(async () => ({ model: rematerialized }));
    await expectModel({
      provider: model.provider,
      modelId: model.id,
      plan: authPlan,
      model,
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
    await expectModel({ config: {}, model, resolveModel }).resolves.toBe(subscriptionModel);
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

  it("rejects caller metadata on the wrong API transport", async () => {
    const modelId = "gpt-5.4-nano";
    const resolveModel = vi.fn();
    await expectModel({
      plan: apiPlan(modelId, { forwardedAuthProfileId: "openai:key", selectedAuthMode: "api_key" }),
      modelId,
      model: {
        ...platformModel,
        id: modelId,
        api: "openai-completions",
        baseUrl: "https://api.openai.com",
      },
      resolveModel,
      rejectMismatchedModel: true,
    }).rejects.toThrow("does not match its prepared api-key route");
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("accepts a canonical API model alias without rediscovery", async () => {
    const model = { ...platformModel, id: "gpt-5.4" };
    const resolveModel = vi.fn();
    await expectModel({
      plan: apiPlan("gpt-5.4-codex"),
      modelId: "gpt-5.4-codex",
      model,
      resolveModel,
    }).resolves.toBe(model);
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("rejects mismatched targets and mismatched resolved tuples", async () => {
    await expectModel({ modelId: "gpt-5.6", resolveModel: vi.fn() }).rejects.toThrow(
      /does not match target/u,
    );

    await expectModel({
      resolveModel: vi.fn(async () => ({ model: platformModel })),
    }).rejects.toThrow(/prepared subscription route/u);
  });
});

describe("generation route-model memo", () => {
  const routedModel = subscriptionModel;
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
      for (const base of [{ ...routedModel }, { ...routedModel }]) {
        await expect(
          materialize(
            nativeModelOwned
              ? {}
              : { forwardedAuthProfileId: undefined, selectedAuthMode: undefined },
            {
              getModel: () => base,
              nativeModelOwned,
              providerUsesProfileScopedModelMetadata: nativeModelOwned,
            },
          ),
        ).resolves.toBe(base);
      }
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
