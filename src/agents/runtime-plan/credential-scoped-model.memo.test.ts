import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { authProvider, subscriptionRoute } from "./auth-fixtures.test-support.js";
import { createPreparedRuntimeModelMaterializer } from "./credential-scoped-model.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

// Fresh object per call, matching prepare-auth minting new plans every turn.
function buildPlan(overrides: Partial<AgentRuntimeAuthPlan> = {}): AgentRuntimeAuthPlan {
  return {
    ...authProvider,
    forwardedAuthProfileId: "openai:subscription",
    selectedAuthMode: "token",
    modelRoute: { ...subscriptionRoute },
    ...overrides,
  };
}

const routedModel = {
  provider: "openai",
  id: "gpt-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};

type Resolution = { model?: typeof routedModel | null; error?: string };

describe("generation route-model memo", () => {
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
      // Mismatched base URL forces route materialization.
      getModel: () => ({ ...routedModel, baseUrl: "https://api.openai.com/v1" }),
      nativeModelOwned: false,
      providerUsesProfileScopedModelMetadata: true,
      generationRouteModelMemo: memo,
      resolveModel,
      ...options,
    });
  beforeEach(() => {
    memo = new Map();
    resolveModel.mockReset().mockResolvedValue({ model: routedModel });
  });

  it("coalesces pending resolution across runs with value-identical plans", async () => {
    const pending = createDeferred<{ model: typeof routedModel }>();
    resolveModel.mockImplementation(() => pending.promise);
    const first = run().materialize(buildPlan());
    const second = run().materialize(buildPlan());
    expect(resolveModel).toHaveBeenCalledTimes(1);
    pending.resolve({ model: routedModel });
    await expect(Promise.all([first, second])).resolves.toEqual([routedModel, routedModel]);
  });

  it("keeps delimiter-containing route identities as distinct memo entries", async () => {
    const materializer = run();

    await materializer.materialize(
      buildPlan({
        forwardedAuthProfileId: "openai:subscription\u0001token",
        selectedAuthMode: undefined,
      }),
    );
    await materializer.materialize(buildPlan());
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "provider-owned dynamic refresh", options: { providerOwnsDynamicModelRefresh: true } },
    { name: "no generation memo", options: { generationRouteModelMemo: undefined } },
  ])("resolves each run with $name", async ({ options }) => {
    await run(options).materialize(buildPlan());
    await run(options).materialize(buildPlan());
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("never pins a rejected resolution for the generation", async () => {
    resolveModel.mockResolvedValueOnce({ error: "transient provider failure" });
    await expect(run().materialize(buildPlan())).rejects.toThrow("transient provider failure");
    expect(memo.size).toBe(0);
    await expect(run().materialize(buildPlan())).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("covers route-less plans so non-OpenAI providers share resolutions too", async () => {
    const routeless = () => buildPlan({ modelRoute: undefined });

    await expect(run().materialize(routeless())).resolves.toBe(routedModel);
    await expect(run().materialize(routeless())).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps each run's base model private (native ownership %s)",
    async (nativeModelOwned) => {
      if (nativeModelOwned) {
        await run().materialize(buildPlan());
      }
      const buildBaseReturningMaterializer = (base: typeof routedModel) =>
        run({
          getModel: () => base,
          nativeModelOwned,
          providerUsesProfileScopedModelMetadata: nativeModelOwned,
        });
      const baseA = { ...routedModel };
      const baseB = { ...routedModel };
      const plan = () =>
        nativeModelOwned
          ? buildPlan()
          : buildPlan({ forwardedAuthProfileId: undefined, selectedAuthMode: undefined });
      await expect(buildBaseReturningMaterializer(baseA).materialize(plan())).resolves.toBe(baseA);
      await expect(buildBaseReturningMaterializer(baseB).materialize(plan())).resolves.toBe(baseB);
      expect(resolveModel).toHaveBeenCalledTimes(nativeModelOwned ? 1 : 0);
      expect(memo.size).toBe(nativeModelOwned ? 1 : 0);
    },
  );

  it("does not let an evicted promise's late rejection remove its replacement", async () => {
    const pending = createDeferred<{ model: typeof routedModel }>();
    resolveModel.mockImplementationOnce(() => pending.promise);
    const turn = (profile: number) =>
      run().materialize(buildPlan({ forwardedAuthProfileId: `openai:profile-${profile}` }));
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
