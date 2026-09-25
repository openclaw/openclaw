import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { Model } from "../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.owner.js";
import {
  createEmptyPreparedModelRuntimeFixture,
  type guardModelFixtureAuth,
} from "./model.fixture.test-support.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import type { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";

export function registerModelAuthReadTests({
  getAgentDir,
  getAuthSpy,
  createRuntimeHooks,
  makeProviderConfig,
  expectResolvedModel,
  expectRecordFields,
}: {
  getAgentDir: () => string;
  getAuthSpy: () => ReturnType<typeof guardModelFixtureAuth>["spy"];
  createRuntimeHooks: () => ReturnType<typeof createProviderRuntimeTestMock>;
  makeProviderConfig: (provider: string, overrides?: Record<string, unknown>) => OpenClawConfig;
  expectResolvedModel: (result: Awaited<ReturnType<typeof resolveModelAsync>>) => Model;
  expectRecordFields: (
    record: unknown,
    expected: Record<string, unknown>,
  ) => Record<string, unknown>;
}) {
  it("consumes a directly prepared model through configured overrides and normalization", async () => {
    const preparedModel = {
      ...makeModel("prepared-model"),
      provider: "acme",
      name: "Prepared Model",
      api: "openai-completions" as const,
      baseUrl: "https://discovered.example/v1",
      input: ["text" as const],
      contextWindow: 65_536,
      maxTokens: 8_192,
    };
    const prepareProviderDynamicModel = vi.fn(async () => {
      getAuthSpy().mockImplementation(() => {
        throw new Error("Auth storage became unavailable after model preparation");
      });
      return preparedModel;
    });
    const runProviderDynamicModel = vi.fn(() => undefined);
    const normalizeProviderResolvedModelWithPlugin = vi.fn(
      ({ context }: { context: { model: Model } }) => ({
        ...context.model,
        name: "Normalized Prepared Model",
      }),
    );
    const cfg = makeProviderConfig("acme", {
      api: "openai-responses",
      baseUrl: "https://configured.example/v1",
      headers: { "X-Tenant": "tenant-a" },
    });

    const result = await resolveModelAsync("acme", "prepared-model", getAgentDir(), cfg, {
      runtimeHooks: {
        ...createRuntimeHooks(),
        prepareProviderDynamicModel,
        runProviderDynamicModel,
        normalizeProviderResolvedModelWithPlugin,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "acme",
      id: "prepared-model",
      name: "Normalized Prepared Model",
      api: "openai-responses",
      baseUrl: "https://configured.example/v1",
      contextWindow: 65_536,
      maxTokens: 8_192,
    });
    expect(expectResolvedModel(result).headers).toEqual(
      expect.objectContaining({ "X-Tenant": "tenant-a" }),
    );
    expect(prepareProviderDynamicModel).toHaveBeenCalledOnce();
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledOnce();
    expect(runProviderDynamicModel).not.toHaveBeenCalled();
  });

  it.each(["auth", "suppressed auth", "prepared miss", "prepared model"] as const)(
    "rejects retired run authority after %s before invoking another provider hook",
    async (stage) => {
      const entered = createDeferred();
      const release = createDeferred();
      const expired = new Error("The model resolution owner retired.");
      let current = true;
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      getAuthSpy().mockImplementation(async () => {
        if (stage === "auth" || stage === "suppressed auth") {
          await pause();
        }
        return { version: 1, profiles: {} };
      });
      const prepareProviderDynamicModel = vi.fn(async () => {
        if (stage === "prepared miss" || stage === "prepared model") {
          await pause();
        }
        return stage === "prepared model"
          ? {
              ...makeModel("candidate"),
              provider: "acme",
              api: "openai-completions" as const,
              baseUrl: "https://discovered.example/v1",
              input: ["text" as const],
              contextWindow: 65_536,
              maxTokens: 8_192,
            }
          : undefined;
      });
      const runProviderDynamicModel = vi.fn(() => makeModel("candidate"));
      const normalizeProviderResolvedModelWithPlugin = vi.fn(() => undefined);
      const resolution = resolveModelAsync(
        stage === "suppressed auth" ? "openai" : "acme",
        stage === "suppressed auth" ? "gpt-5.3-codex-spark" : "candidate",
        getAgentDir(),
        undefined,
        {
          skipAgentDiscovery: true,
          assertCurrent() {
            if (!current) {
              throw expired;
            }
          },
          runtimeHooks: {
            ...createRuntimeHooks(),
            prepareProviderDynamicModel,
            runProviderDynamicModel,
            normalizeProviderResolvedModelWithPlugin,
            shouldPreferProviderRuntimeResolvedModel: () => true,
          },
        },
      );
      try {
        await Promise.race([
          entered.promise,
          resolution.then(() => {
            throw new Error("Model resolution settled before the preparation barrier.");
          }),
        ]);
        current = false;
        release.resolve();
        await expect(resolution.then(() => "resolved")).rejects.toBe(expired);
        expect(prepareProviderDynamicModel).toHaveBeenCalledTimes(
          stage.startsWith("prepared") ? 1 : 0,
        );
        expect(runProviderDynamicModel).not.toHaveBeenCalled();
        expect(normalizeProviderResolvedModelWithPlugin).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await resolution.catch(() => {});
      }
    },
  );

  it("reuses an empty auth result when async model preparation falls back to the sync hook", async () => {
    getAuthSpy().mockResolvedValueOnce({ version: 1, profiles: {} });
    const prepareProviderDynamicModel = vi.fn(async () => {
      getAuthSpy().mockImplementation(() => {
        throw new Error("Auth storage became unavailable after model preparation");
      });
      return undefined;
    });
    const runProviderDynamicModel = vi.fn(() => ({
      ...makeModel("fallback-model"),
      provider: "acme",
      api: "openai-completions" as const,
      baseUrl: "https://discovered.example/v1",
    }));

    const result = await resolveModelAsync("acme", "fallback-model", getAgentDir(), undefined, {
      runtimeHooks: {
        ...createRuntimeHooks(),
        prepareProviderDynamicModel,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "acme",
      id: "fallback-model",
      api: "openai-completions",
      baseUrl: "https://discovered.example/v1",
    });
    expect(getAuthSpy()).toHaveBeenCalledOnce();
    expect(prepareProviderDynamicModel).toHaveBeenCalledOnce();
    expect(runProviderDynamicModel).toHaveBeenCalledOnce();
  });

  it("keeps a retained generation usable while its model resolution owner is active", async () => {
    const cfg: OpenClawConfig = {};
    const assertCurrent = vi.fn();
    const preparedModelRuntime: PreparedModelRuntimeSnapshot = {
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir: getAgentDir(),
        config: cfg,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        createStores: createEmptyAgentDiscoveryStores,
      }),
      isCurrent: () => false,
    };
    getAuthSpy().mockImplementation(() => {
      throw new Error("Prepared auth must not read credentials again");
    });
    const runProviderDynamicModel = vi.fn(() => ({
      ...makeModel("retained-model"),
      provider: "acme",
    }));
    const result = await resolveModelAsync("acme", "retained-model", getAgentDir(), cfg, {
      preparedModelRuntime,
      authProfileMode: "api_key",
      assertCurrent,
      runtimeHooks: { ...createRuntimeHooks(), runProviderDynamicModel },
    });
    expect(expectResolvedModel(result).id).toBe("retained-model");
    expect(assertCurrent).toHaveBeenCalled();
    expect(getAuthSpy()).not.toHaveBeenCalled();
    expect(runProviderDynamicModel).toHaveBeenCalledOnce();
  });
}
