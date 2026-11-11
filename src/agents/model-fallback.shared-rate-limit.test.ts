import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createProviderRateLimitRequest } from "../llm/provider-rate-limit.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import * as staticCatalog from "./embedded-agent-runner/model.static-catalog.js";
import { FailoverError } from "./failover-error.js";
import { markFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { prepareModelFallbackRateLimit } from "./model-fallback-rate-limit.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { buildEmbeddedRunnerAssistant } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const provider = "shared-tpm-test";
const baseUrl = "https://shared-tpm.example/v1";
const apiKey = "synthetic-shared-account";
const cfg = {
  plugins: { enabled: false },
  agents: {
    defaults: { model: { primary: `${provider}/primary`, fallbacks: [`${provider}/backup`] } },
  },
  models: {
    providers: {
      [provider]: {
        api: "openai-responses",
        auth: "api-key",
        apiKey,
        baseUrl,
        models: ["primary", "backup", "last"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16000,
          maxTokens: 1000,
        })),
      },
    },
  },
} satisfies OpenClawConfig;
const request = (id: string, headers?: Record<string, string>) =>
  createProviderRateLimitRequest(
    { id, provider, baseUrl, headers },
    { apiKey, maxRetryDelayMs: 0 },
  );
function saturate(id: string, delay: number, headers?: Record<string, string>) {
  request(id, headers).observe?.(
    buildEmbeddedRunnerAssistant({
      provider,
      model: id,
      stopReason: "error",
      retryAfterMs: delay,
      errorMessage: `429 Rate limit reached for ${id} in organization org-shared-test on tokens per min (TPM). Please try again in ${delay / 1000}s.`,
    }),
  );
}
const runTurn = (
  sessionId: string,
  run: Parameters<typeof runWithModelFallback<string>>[0]["run"],
  fallbacksOverride?: string[],
) =>
  runWithModelFallback({
    cfg,
    provider,
    model: "primary",
    sessionId,
    skipAuthProfileRuntime: true,
    manifestPlugins: [],
    run,
    fallbacksOverride,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 26));
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(120_000);
  vi.useRealTimers();
});

it("routes bundled models around saturation using configured organization headers", async () => {
  const headers = { "OpenAI-Organization": "org-shared-test" };
  const providerConfig = { ...cfg.models.providers[provider], headers };
  const models = providerConfig.models.map((model) => ({
    ...model,
    provider,
    baseUrl,
    api: providerConfig.api,
  }));
  const catalog = vi
    .spyOn(staticCatalog, "resolveBundledStaticCatalogModel")
    .mockImplementation(({ modelId }) => models.find((model) => model.id === modelId));
  try {
    saturate("primary", 20_000, headers);
    const run = vi.fn(async (_provider: string, model: string) => model);
    const result = await runWithModelFallback({
      cfg: { ...cfg, models: { providers: { [provider]: providerConfig } } },
      provider,
      model: "primary",
      sessionId: "shared-configured-org",
      skipAuthProfileRuntime: true,
      manifestPlugins: [],
      run,
    });
    expect(run.mock.calls.map(([, model]) => model)).toEqual(["backup"]);
    expect(result.attempts).toMatchObject([{ model: "primary", reason: "rate_limit" }]);
  } finally {
    catalog.mockRestore();
  }
});

it("routes other sessions around shared model saturation, then resumes primary after expiry", async () => {
  saturate("primary", 20_000);
  const run = vi.fn<Parameters<typeof runWithModelFallback<string>>[0]["run"]>(
    async (_provider, model) => model,
  );
  const first = await runTurn("shared-new-session", run);
  expect(run.mock.calls.map(([, model]) => model)).toEqual(["backup"]);
  expect(first.attempts).toMatchObject([{ model: "primary", reason: "rate_limit" }]);
  expect(run.mock.calls[0]?.[2]?.modelRoutingProvenance).toMatchObject({
    stage: "fallback",
    fallbackReason: "rate_limit",
  });

  const backupFailure = vi.fn(async (_provider: string, model: string) => {
    if (model === "backup") {
      throw new FailoverError("Backup is overloaded", { reason: "overloaded", status: 503 });
    }
    return model;
  });
  const recovered = await runTurn("shared-failed-backup", backupFailure, [
    `${provider}/backup`,
    `${provider}/last`,
  ]);
  expect(backupFailure.mock.calls.map(([, model]) => model)).toEqual(["backup", "last"]);
  expect(recovered.model).toBe("last");

  markFallbackCandidateSkipped({
    sessionId: "shared-unavailable-backup",
    provider,
    model: "backup",
    reason: "auth",
    ttlMs: 60_000,
  });
  const unavailable = await runTurn("shared-unavailable-backup", run);
  expect(unavailable.model).toBe("primary");

  await vi.advanceTimersByTimeAsync(80_001);
  expect((await runTurn("shared-recovered-session", run)).model).toBe("primary");
});

it("waits in the earliest shared gate when both models are saturated and preserves strict requests", async () => {
  saturate("primary", 20_000);
  saturate("backup", 5_000);
  const sent: string[] = [];
  const run = vi.fn(async (_provider: string, model: string) => {
    await request(model).wait();
    sent.push(model);
    return model;
  });
  const pending = runTurn("shared-both-saturated", run);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(sent).toEqual(["backup"]);
  expect((await pending).model).toBe("backup");

  const strict = runTurn("shared-strict", run, []);
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await strict).model).toBe("primary");
  expect(sent).toEqual(["backup", "primary"]);
});

it("reads saturation for the pinned starting account before possible recovery accounts", () => {
  saturate("primary", 20_000);
  const profileConfig: OpenClawConfig = {
    ...cfg,
    models: {
      providers: { [provider]: { ...cfg.models.providers[provider], apiKey: undefined } },
    },
  };
  const authStore: AuthProfileStore = {
    version: 1,
    profiles: {
      pinned: { type: "api_key", provider, key: apiKey },
      recovery: { type: "api_key", provider, key: "synthetic-recovery-account" },
    },
  };
  const chain = resolveModelCandidateChain({
    cfg: profileConfig,
    provider,
    model: "primary",
    manifestPlugins: [],
  });
  const routed = prepareModelFallbackRateLimit(chain, {
    cfg: profileConfig,
    authStore,
    userLockedAuthProfileId: "pinned",
  });
  expect(routed.candidates[0]?.model).toBe("backup");
});
