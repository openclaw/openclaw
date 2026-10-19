import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { configFor } from "../model-auth.fixtures.test-support.js";
import {
  authProvider,
  platformModel,
  subscriptionModel,
  subscriptionRoute,
} from "./auth-fixtures.test-support.js";
import { materializePreparedRuntimeModel, type RuntimeRouteModel } from "./materialize-model.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

const plan: AgentRuntimeAuthPlan = {
  ...authProvider,
  forwardedAuthProfileId: "openai:subscription",
  selectedAuthMode: "token",
  modelRoute: subscriptionRoute,
};

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
      ...plan.modelRoute!,
      modelId,
      api: "openai-responses",
      baseUrl,
      authRequirement: "api-key",
    },
  };
}

describe("materializePreparedRuntimeModel", () => {
  it.each(["matching", "resolved", "route-less"] as const)(
    "rejects a retired final %s route without rejecting its API sibling",
    async (mode) => {
      const registry = makeRegistry([
        { id: "retirement-owner", channels: [], providers: ["openai"], origin: "bundled" },
      ]);
      Object.assign(expectDefined(registry.plugins[0], "retirement fixture owner"), {
        enabledByDefault: true,
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: "gpt-retirement-fixture",
              retirement: {},
              when: {
                baseUrlHosts: ["subscription.example"],
                providerConfigApiIn: ["openai-chatgpt-responses"],
              },
            },
          ],
        },
      });
      const metadataSnapshot = createPluginMetadataSnapshot({ manifestRegistry: registry });
      const model = {
        provider: "openai",
        id: "gpt-retirement-fixture",
        api: "openai-chatgpt-responses",
        baseUrl: "https://subscription.example/v1",
      };
      const subscriptionPlan: AgentRuntimeAuthPlan = {
        ...plan,
        modelRoute: { ...plan.modelRoute!, modelId: model.id, baseUrl: model.baseUrl },
      };
      const resolveModel = vi.fn(async () => ({ model }));
      const config = configFor(
        "openai",
        mode === "route-less" ? model.baseUrl : "https://api.example/v1",
        {
          api: mode === "route-less" ? "openai-chatgpt-responses" : "openai-responses",
        },
      );
      await expectModel({
        plan:
          mode === "route-less"
            ? { providerForAuth: "openai", authProfileProviderForAuth: "openai" }
            : subscriptionPlan,
        modelId: model.id,
        config,
        metadataSnapshot,
        ...(mode === "resolved" ? {} : { model }),
        resolveModel,
      }).rejects.toMatchObject({
        reason: "model_not_found",
        message: expect.stringContaining("openclaw doctor --fix"),
      });
      expect(resolveModel).toHaveBeenCalledTimes(mode === "resolved" ? 1 : 0);

      const apiModel = { ...model, api: "openai-responses", baseUrl: "https://api.example/v1" };
      await expectModel({
        plan: apiPlan(model.id, {}, apiModel.baseUrl),
        modelId: model.id,
        config,
        metadataSnapshot,
        model,
        resolveModel: async () => ({ model: apiModel }),
      }).resolves.toBe(apiModel);
    },
  );

  it.each([true, false])("re-resolves profile-scoped metadata (routed: %s)", async (routed) => {
    const model = routed
      ? subscriptionModel
      : {
          provider: "clawrouter",
          id: "private-model",
          api: "anthropic-messages",
          baseUrl: "https://router.example.test",
        };
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

  it("projects the selected route and exact auth mode before resolving", async () => {
    const resolveModel = vi.fn<MaterializeParams<typeof subscriptionModel>["resolveModel"]>(
      async () => ({
        model: subscriptionModel,
      }),
    );

    await expectModel({
      config: { models: { providers: {} } },
      model: platformModel,
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

  it("rejects provider metadata that uses a different official adapter", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-completions",
      baseUrl: "https://api.openai.com",
    };
    const resolveModel = vi.fn();

    await expectModel({
      plan: apiPlan("gpt-5.4-nano", {
        forwardedAuthProfileId: "openai:key",
        selectedAuthMode: "api_key",
      }),
      modelId: "gpt-5.4-nano",
      model,
      rejectMismatchedModel: true,
      resolveModel,
    }).rejects.toThrow("does not match its prepared api-key route");
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("accepts the canonical model id for the shipped GPT-5.4 alias on its API route", async () => {
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

  it("does not reuse another model that shares the prepared transport", async () => {
    const resolveModel = vi.fn(async () => ({ model: subscriptionModel }));

    await expectModel({
      model: { ...subscriptionModel, id: "gpt-5.4" },
      resolveModel,
    }).resolves.toBe(subscriptionModel);
    expect(resolveModel).toHaveBeenCalledOnce();
  });

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
