import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

const cfg = createModelFallbackConfig("fixture/primary", [
  "fixture/restricted-v1",
  "fixture/fallback",
]);
cfg.agents!.defaults!.models = { "fixture/restricted-v1": { alias: "special" } };

const source = (assertCurrent = () => {}) =>
  createAdmittedRunOperatorAuthority({
    profileId: "fixture-operator",
    scopes: ["operator.write"],
    assertCurrent,
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["fixture/restricted-*"] },
      manifestPlugins: [],
    }),
  });

const fallbackOptions = { cfg, provider: "fixture", model: "primary", manifestPlugins: [] };
const run = vi.fn<(provider: string, model: string) => Promise<string>>();
const prepare =
  vi.fn<NonNullable<Parameters<typeof runWithModelFallback>[0]["prepareCandidateChain"]>>();
beforeEach(() => {
  run.mockReset();
  prepare.mockReset();
});
function fallback(overrides: Partial<Parameters<typeof runWithModelFallback>[0]> = {}) {
  return runWithModelFallback({
    ...fallbackOptions,
    operatorAuthority: source(),
    prepareCandidateChain: prepare,
    run,
    ...overrides,
  });
}

it.each(["rate_limit", "context_overflow"] as const)(
  "never prepares or executes denied fallbacks after %s",
  async (reason) => {
    run.mockRejectedValueOnce(new FailoverError("fixture primary exhausted", { reason }));
    run.mockResolvedValue("answer");
    const result = await fallback({ skipAuthProfileRuntime: true });
    expect(result.result).toBe("answer");
    expect(run.mock.calls.map((call) => call[1])).toEqual(["primary", "fallback"]);
    expect(prepare.mock.calls[0]?.[0].map(({ model }) => model)).toEqual(["primary", "fallback"]);
  },
);

it("rejects a denied alias before provider or harness preparation", async () => {
  await expect(fallback({ model: "special", fallbacksOverride: [] })).rejects.toThrow(
    "operator role cannot use this model",
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("rechecks retained authority after asynchronous preparation before starting a model", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  let active = true;
  const pending = fallback({
    skipAuthProfileRuntime: true,
    operatorAuthority: source(() => {
      if (!active) {
        throw new Error("source retired");
      }
    }),
    prepareCandidateChain: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  active = false;
  release.resolve();
  await expect(pending).rejects.toThrow("source retired");
  expect(run).not.toHaveBeenCalled();
});
