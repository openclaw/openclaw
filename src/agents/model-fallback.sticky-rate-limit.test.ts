import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createProviderRateLimitRequest,
  withProviderRateLimitRetryDeadline,
} from "../llm/provider-rate-limit.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { prepareModelFallbackRateLimit } from "./model-fallback-rate-limit.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { MODEL_FALLBACK_SKIPPED_CODE } from "./model-fallback.types.js";
import { buildEmbeddedRunnerAssistant } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const start = Date.UTC(2026, 0, 1);
const minute = 60_000;

function runTurn(
  sessionId: string,
  run: Parameters<typeof runWithModelFallback<string>>[0]["run"],
  stickyRateLimitFallback?: boolean,
) {
  return runWithModelFallback({
    cfg: { plugins: { enabled: false } },
    provider: "sticky-provider",
    model: "primary",
    fallbacksOverride: ["sticky-provider/backup"],
    manifestPlugins: [],
    skipAuthProfileRuntime: true,
    sessionId,
    stickyRateLimitFallback,
    run,
  });
}

function failPrimary(status = 429) {
  return vi.fn(async (_provider: string, model: string) => {
    if (model === "primary") {
      throw Object.assign(new Error("synthetic provider failure"), { status });
    }
    return "backup reply";
  });
}

async function expectSelectedModel(sessionId: string, model: string) {
  const run = vi.fn<Parameters<typeof runWithModelFallback<string>>[0]["run"]>(
    async (_provider, selected) => selected,
  );
  const result = await runTurn(sessionId, run, true);
  expect(result.result).toBe(model);
  return { run, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session rate-limit fallback stickiness", () => {
  it("keeps the fallback warm only for the rate-limited session until idle expiry", async () => {
    const first = failPrimary();
    const result = await runTurn("sticky-session", first, true);
    expect(first.mock.calls.map(([, model]) => model)).toEqual(["primary", "backup"]);
    expect(result.attempts).toMatchObject([{ model: "primary", reason: "rate_limit" }]);

    await expectSelectedModel("other-session", "primary");

    vi.setSystemTime(start + minute);
    const { run: second, result: warm } = await expectSelectedModel("sticky-session", "backup");
    // The skipped selected model keeps the rate-limit reason visible to /status.
    expect(warm.attempts).toMatchObject([
      { model: "primary", reason: "rate_limit", code: MODEL_FALLBACK_SKIPPED_CODE },
    ]);
    expect(second.mock.calls[0]?.[2]?.modelRoutingProvenance).toMatchObject({
      stage: "fallback",
      fallbackReason: "rate_limit",
    });

    vi.setSystemTime(start + 11 * minute + 1);
    await expectSelectedModel("sticky-session", "primary");
  });

  it("caps sliding reuse at 30 minutes and clears a failed sticky attempt", async () => {
    await runTurn("sticky-session", failPrimary(), true);
    for (const minutes of [5, 10, 15, 20, 25, 30]) {
      vi.setSystemTime(start + minutes * minute);
      await expectSelectedModel("sticky-session", "backup");
    }
    vi.setSystemTime(start + 30 * minute + 1);
    await expectSelectedModel("sticky-session", "primary");

    await runTurn("sticky-session", failPrimary(), true);
    const failingSticky = vi.fn(async (_provider: string, model: string) => {
      if (model === "backup") {
        throw Object.assign(new Error("synthetic server error"), { status: 500 });
      }
      return "primary reply";
    });
    await runTurn("sticky-session", failingSticky, true);
    expect(failingSticky.mock.calls.map(([, model]) => model)).toEqual(["backup", "primary"]);
    await expectSelectedModel("sticky-session", "primary");
  });

  it("does not stick after other failures or without the opt-in", async () => {
    for (const { status, enabled } of [
      { status: 500, enabled: true },
      { status: 429, enabled: undefined },
    ]) {
      const first = failPrimary(status);
      await runTurn("sticky-session", first, enabled);
      expect(first.mock.calls.map(([, model]) => model)).toEqual(["primary", "backup"]);
      await expectSelectedModel("sticky-session", "primary");
    }
  });
});

describe("shared model saturation guards", () => {
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
  const runSharedTurn = (
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
  beforeEach(() => vi.setSystemTime(Date.UTC(2026, 9, 26)));
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(120000);
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
    const pending = runSharedTurn("shared-both-saturated", run);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["backup"]);
    expect((await pending).model).toBe("backup");

    const strict = runSharedTurn("shared-strict", run, []);
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
  it.each(["header"])("blocks later turns on a generic timed 429 (%s)", async (source) => {
    const model = { id: "long-limit", provider, baseUrl };
    const initialRequest = createProviderRateLimitRequest(model, { apiKey });
    const resetAt = Date.now() + 3 * 86_400_000;
    initialRequest.observe?.(
      buildEmbeddedRunnerAssistant({
        stopReason: "error",
        errorMessage: "429 Too Many Requests",
        ...(source === "header"
          ? { errorBody: JSON.stringify({ headers: { "retry-after": "259200" } }) }
          : { errorMessage: "429 Too Many Requests; Retry-After: 259200 seconds" }),
      }),
    );
    await expect(createProviderRateLimitRequest(model, { apiKey }).wait()).rejects.toMatchObject({
      reason: "rate_limit",
      provider,
      model: "long-limit",
      rateLimitResetAt: resetAt,
    });
    await expect(
      withProviderRateLimitRetryDeadline(performance.now() + 15_000, () =>
        createProviderRateLimitRequest(model, { apiKey }).wait(),
      ),
    ).rejects.toMatchObject({ provider, model: "long-limit", rateLimitResetAt: resetAt });
    await expect(
      createProviderRateLimitRequest(model, { apiKey: "synthetic-other" }).wait(),
    ).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(3 * 86_400_000 + 60_001);
    await expect(createProviderRateLimitRequest(model, { apiKey }).wait()).resolves.toBeUndefined();
  });
});
