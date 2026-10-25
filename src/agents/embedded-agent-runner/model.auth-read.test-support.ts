import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { Model } from "../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import {
  createEmptyPreparedModelRuntimeFixture,
  type guardModelFixtureAuth,
} from "./model.fixture.test-support.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.js";
import type { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";

export function registerModelAuthReadTests({
  getAgentDir,
  getAuthSpy,
  createRuntimeHooks,
  expectResolvedModel,
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
  const candidate = { ...makeModel("candidate"), provider: "acme" };
  const prepareWithoutRereadingAuth = (model?: Model) =>
    vi.fn(async () => {
      getAuthSpy().mockImplementation(() => {
        throw new Error("Auth read after preparation");
      });
      return model;
    });
  const resolve = (hooks: Partial<ProviderRuntimeHooks>) =>
    resolveModelAsync("acme", candidate.id, getAgentDir(), undefined, {
      runtimeHooks: { ...createRuntimeHooks(), ...hooks },
      skipAgentDiscovery: true,
    });

  // Configured overlays and normalization are owned by model.test.ts and model.provider-hooks.test.ts.
  it("does not reread auth after a directly prepared model resolves", async () => {
    const result = await resolve({
      prepareProviderDynamicModel: prepareWithoutRereadingAuth(candidate),
      runProviderDynamicModel: () => {
        throw new Error("Unexpected sync fallback");
      },
    });
    expect(expectResolvedModel(result).id).toBe(candidate.id);
  });

  it.each(["auth", "suppressed auth", "prepared model"] as const)(
    "rejects retired run authority after %s before invoking another provider hook",
    async (stage) => {
      const gate = createEnteredGate();
      const expired = new Error("The model resolution owner retired.");
      let current = true;
      const afterAuth = stage !== "prepared model";
      getAuthSpy().mockImplementation(async () => {
        if (afterAuth) {
          await gate.wait();
        }
        return { version: 1, profiles: {} };
      });
      const prepare = vi.fn(async () => {
        if (!afterAuth) {
          await gate.wait();
        }
        return candidate;
      });
      const run = vi.fn(() => candidate);
      const normalize = vi.fn(() => undefined);
      const suppressed = stage === "suppressed auth";
      const resolution = resolveModelAsync(
        suppressed ? "openai" : "acme",
        suppressed ? "gpt-5.3-codex-spark" : candidate.id,
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
            prepareProviderDynamicModel: prepare,
            runProviderDynamicModel: run,
            normalizeProviderResolvedModelWithPlugin: normalize,
            shouldPreferProviderRuntimeResolvedModel: () => true,
          },
        },
      );
      try {
        await awaitGateBeforeSettlement(
          gate.entered,
          resolution,
          "Model resolved before the barrier",
        );
        current = false;
        gate.release();
        await expect(resolution).rejects.toBe(expired);
        expect(prepare).toHaveBeenCalledTimes(afterAuth ? 0 : 1);
        expect(run).not.toHaveBeenCalled();
        expect(normalize).not.toHaveBeenCalled();
      } finally {
        gate.release();
        await resolution.catch(() => {});
      }
    },
  );

  it("reuses empty auth when async model preparation falls back to the sync hook", async () => {
    getAuthSpy().mockResolvedValueOnce({ version: 1, profiles: {} });
    const result = await resolve({
      prepareProviderDynamicModel: prepareWithoutRereadingAuth(),
      runProviderDynamicModel: () => candidate,
    });
    expect(expectResolvedModel(result).id).toBe(candidate.id);
    expect(getAuthSpy()).toHaveBeenCalledOnce();
  });

  it("keeps a retained generation usable while its model resolution owner is active", async () => {
    const cfg: OpenClawConfig = {};
    const assertCurrent = vi.fn();
    const preparedModelRuntime = {
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir: getAgentDir(),
        config: cfg,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        createStores: createEmptyAgentDiscoveryStores,
      }),
      isCurrent: () => false,
    };
    getAuthSpy().mockImplementation(() => {
      throw new Error("Prepared auth was reread");
    });
    const result = await resolveModelAsync("acme", candidate.id, getAgentDir(), cfg, {
      preparedModelRuntime,
      authProfileMode: "api_key",
      assertCurrent,
      runtimeHooks: { ...createRuntimeHooks(), runProviderDynamicModel: () => candidate },
    });
    expect(expectResolvedModel(result).id).toBe(candidate.id);
    expect(assertCurrent).toHaveBeenCalled();
    expect(getAuthSpy()).not.toHaveBeenCalled();
  });
}
