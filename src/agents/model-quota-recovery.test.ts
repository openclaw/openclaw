import { expect, it, vi } from "vitest";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { describeFailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { resolveModelQuotaRecoveryPolicy } from "./model-selection-config.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

const cfg: OpenClawConfig = {
  plugins: { enabled: false },
  agents: { defaults: { model: { primary: "fixture/default-model" } } },
};
const selection = {
  cfg,
  agentId: "main",
  hasSessionModelOverride: true,
  selectedModel: { provider: "fixture", model: "selected-model" },
  modelOverrideSource: "user" as const,
};
const daily = Object.assign(new Error("Quota exhausted"), {
  status: 429,
  code: "RESOURCE_EXHAUSTED",
  quotaScope: "daily-model",
});

it("distinguishes an omitted ladder from explicit disablement without overriding selection", () => {
  expect(resolveModelQuotaRecoveryPolicy(selection)).toEqual({
    kind: "eligible",
    target: { provider: "fixture", model: "default-model" },
  });
  for (const fallbacks of [[], ["fixture/backup"]]) {
    expect(
      resolveModelQuotaRecoveryPolicy({
        ...selection,
        cfg: { agents: { defaults: { model: { primary: "fixture/default-model", fallbacks } } } },
      }),
    ).toEqual({ kind: "blocked", reason: fallbacks.length ? "configured_fallbacks" : "disabled" });
  }
  expect(resolveModelQuotaRecoveryPolicy({ ...selection, modelFallbacksOverride: [] })).toEqual({
    kind: "blocked",
    reason: "disabled",
  });
  expect(resolveModelQuotaRecoveryPolicy({ ...selection, modelSelectionLocked: true })).toEqual({
    kind: "blocked",
    reason: "locked",
  });
  expect(resolveModelQuotaRecoveryPolicy({ ...selection, modelOverrideSource: "auto" })).toEqual({
    kind: "blocked",
    reason: "configured_fallbacks",
  });
  expect(
    resolveModelQuotaRecoveryPolicy({
      ...selection,
      selectedModel: { provider: "other-fixture", model: "selected-model" },
    }),
  ).toEqual({ kind: "blocked", reason: "no_same_provider_default" });
});

it.each([
  { count: 1, verified: true, locked: false, eligible: true },
  { count: 2, verified: true, locked: false, eligible: false },
  { count: 1, verified: false, locked: false, eligible: false },
  { count: 1, verified: true, locked: true, eligible: false },
])(
  "records a switch-only candidate only with verified scope and single-profile selection: %j",
  async ({ count, verified, locked, eligible }) => {
    await withOpenClawTestState({ layout: "home", prefix: "quota-recovery-" }, async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `fixture:profile-${index}`,
            { type: "api_key" as const, provider: "fixture", key: "synthetic-key" },
          ]),
        ),
      });
      const run = vi.fn(async (_provider: string, _model: string) => {
        throw Object.assign(new Error(daily.message), daily, {
          quotaScope: verified ? "daily-model" : undefined,
        });
      });
      const error = await runWithModelFallback({
        cfg,
        provider: "fixture",
        model: "selected-model",
        agentDir: state.agentDir(),
        fallbacksOverride: [],
        manifestPlugins: [],
        modelQuotaRecoveryPolicy: resolveModelQuotaRecoveryPolicy({
          ...selection,
          modelSelectionLocked: locked,
        }),
        run,
      }).catch((failure: unknown) => failure);
      expect(describeFailoverError(error).quotaScope).toBe(verified ? "daily-model" : undefined);
      expect(describeFailoverError(error).quotaRecovery).toEqual(
        eligible
          ? {
              provider: "fixture",
              model: "default-model",
              continuation: "unavailable",
            }
          : undefined,
      );
      expect(run).toHaveBeenCalledTimes(1);
    });
  },
);

it.each([429, 402])(
  "consumes producer-projected terminal facts without inventing continuation proof (status=%s)",
  async (status) => {
    await withOpenClawTestState(
      { layout: "home", prefix: "quota-terminal-body-" },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "fixture:single": { type: "api_key", provider: "fixture", key: "synthetic-key" },
          },
        });
        const run = vi.fn(async () => ({
          payloads: buildPayloads({
            provider: "fixture",
            lastAssistant: makeAssistantMessageFixture({
              provider: "fixture",
              model: "selected-model",
              ...projectProviderError({
                status,
                code: "RESOURCE_EXHAUSTED",
                quotaScope: "daily-model",
                message: "Quota exhausted",
                model: "selected-model",
                provider: "fixture",
              }),
            }),
          }),
          meta: { durationMs: 1 },
        }));
        const failure: unknown = await runWithModelFallback({
          cfg,
          provider: "fixture",
          model: "selected-model",
          agentDir: state.agentDir(),
          manifestPlugins: [],
          fallbacksOverride: [],
          modelQuotaRecoveryPolicy: resolveModelQuotaRecoveryPolicy(selection),
          classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
          run,
        }).catch((error: unknown) => error);
        const described = describeFailoverError(failure);
        expect(described.quotaScope).toBe(status === 429 ? "daily-model" : undefined);
        expect(described.quotaRecovery).toEqual(
          status === 429
            ? { provider: "fixture", model: "default-model", continuation: "unavailable" }
            : undefined,
        );
        expect(run).toHaveBeenCalledOnce();
      },
    );
  },
);

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
    modelQuotaRecoveryPolicy: resolveModelQuotaRecoveryPolicy(selection),
    run,
  }).catch((failure: unknown) => failure);
  expect(run.mock.calls.map((call) => call[1])).toEqual(["selected-model", "backup"]);
  expect(describeFailoverError(error)).toMatchObject({
    quotaScope: "daily-model",
    model: "backup",
  });
  expect(describeFailoverError(error).quotaRecovery).toBeUndefined();
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
      modelQuotaRecoveryPolicy: resolveModelQuotaRecoveryPolicy(selection),
      canFallbackAfterError: () => false,
      run,
    }),
  ).rejects.toMatchObject({
    reason: "rate_limit",
    quotaScope: "daily-model",
    quotaRecovery: undefined,
  });
  expect(effects).toBe(1);
  expect(run).toHaveBeenCalledTimes(1);
});
