import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";

const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: "fixture/primary",
        fallbacks: ["fixture/restricted-v1", "fixture/fallback"],
      },
      models: { "fixture/restricted-v1": { alias: "special" } },
    },
  },
};

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

describe("operator model execution ceiling", () => {
  it("never prepares or executes denied fallbacks, while retaining ordinary allowed failover", async () => {
    const prepared = vi.fn();
    const run = vi.fn(async (_provider: string, model: string) => {
      if (model === "primary") {
        throw new FailoverError("fixture primary exhausted", { reason: "rate_limit" });
      }
      return "answer";
    });
    const result = await runWithModelFallback({
      cfg,
      provider: "fixture",
      model: "primary",
      manifestPlugins: [],
      skipAuthProfileRuntime: true,
      operatorAuthority: source(),
      prepareCandidateChain: prepared,
      run,
    });
    expect(result.result).toBe("answer");
    expect(run.mock.calls.map((call) => call[1])).toEqual(["primary", "fallback"]);
    expect(
      prepared.mock.calls[0]?.[0].map((candidate: { model: string }) => candidate.model),
    ).toEqual(["primary", "fallback"]);
  });

  it("rejects a denied alias before provider or harness preparation", async () => {
    const prepare = vi.fn();
    const run = vi.fn();
    await expect(
      runWithModelFallback({
        cfg,
        provider: "fixture",
        model: "special",
        fallbacksOverride: [],
        manifestPlugins: [],
        operatorAuthority: source(),
        prepareCandidateChain: prepare,
        run,
      }),
    ).rejects.toThrow("operator role cannot use this model");
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("rechecks retained authority after asynchronous preparation before starting a model", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    let active = true;
    const run = vi.fn();
    const pending = runWithModelFallback({
      cfg,
      provider: "fixture",
      model: "primary",
      manifestPlugins: [],
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
      run,
    });
    await entered.promise;
    active = false;
    release.resolve();
    await expect(pending).rejects.toThrow("source retired");
    expect(run).not.toHaveBeenCalled();
  });
});
