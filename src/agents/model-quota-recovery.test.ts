import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeFailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

const daily = Object.assign(new Error("Quota exhausted"), {
  status: 429,
  code: "RESOURCE_EXHAUSTED",
  quotaScope: "daily-model",
});
const cfg: OpenClawConfig = {
  plugins: { enabled: false },
  agents: { defaults: { model: { primary: "fixture/default-model" } } },
};
it("uses configured fallbacks without appending a recovery candidate after exhaustion", async () => {
  const run = vi.fn(async (_provider: string, _model: string) => {
    throw daily;
  });
  const error = await runWithModelFallback({
    cfg,
    provider: "fixture",
    model: "selected-model",
    skipAuthProfileRuntime: true,
    fallbacksOverride: ["fixture/backup"],
    manifestPlugins: [],
    run,
  }).catch((failure: unknown) => failure);
  expect(run.mock.calls.map((call) => call[1])).toEqual(["selected-model", "backup"]);
  expect(describeFailoverError(error)).toMatchObject({
    quotaScope: "daily-model",
    model: "backup",
  });
});

it("honors committed-work replay veto without duplicating a completed action", async () => {
  let effects = 0;
  const run = vi.fn(async (_provider: string, _model: string) => {
    effects += 1;
    throw daily;
  });
  await expect(
    runWithModelFallback({
      cfg,
      provider: "fixture",
      model: "selected-model",
      skipAuthProfileRuntime: true,
      fallbacksOverride: ["fixture/backup"],
      manifestPlugins: [],
      canFallbackAfterError: () => false,
      run,
    }),
  ).rejects.toMatchObject({
    reason: "rate_limit",
    quotaScope: "daily-model",
  });
  expect(effects).toBe(1);
  expect(run).toHaveBeenCalledTimes(1);
});
