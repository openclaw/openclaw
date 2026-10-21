import { describe, expect, it } from "vitest";
import {
  assertAgainstBaseline,
  evaluateAgainstBaseline,
  isAnthropicToolProbeDrift,
  resolveCacheProbeMaxTokens,
  resolveLiveCacheProviderPool,
  shouldAcceptEmptyCacheProbe,
  shouldRetryBaselineFindings,
  shouldRetryCacheProbeText,
  type BaselineFindings,
  type CacheRun,
} from "./live-cache-regression-policy.js";
import {
  LiveCachePrerequisiteSkip,
  toLiveCachePrerequisiteSkip,
} from "./live-cache-test-support.js";
import { ProviderAuthError } from "./model-auth-runtime-shared.js";

function cacheRun(usage: CacheRun["usage"], hitRate = 0.999): CacheRun {
  return { hitRate, usage, suffix: "hit", text: "CACHE-OK hit" };
}

describe("live cache regression runner", () => {
  it("keeps OpenAI text cache floor misses advisory", () => {
    const findings: BaselineFindings = { regressions: [], warnings: [] };

    assertAgainstBaseline({
      lane: "stable",
      provider: "openai",
      result: {
        best: cacheRun({ cacheRead: 0, cacheWrite: 0, input: 5_034 }, 0),
      },
      ...findings,
    });

    expect(findings).toStrictEqual({
      regressions: [],
      warnings: ["openai:stable cacheRead=0 < min=4608", "openai:stable hitRate=0.000 < min=0.900"],
    });
  });

  it("retries hard cache baseline misses once", () => {
    const hard = { regressions: ["anthropic:image cacheRead=0 < min=4500"], warnings: [] };
    const advisory = { regressions: [], warnings: ["openai:image cacheRead=0 < min=3840"] };
    expect(shouldRetryBaselineFindings(hard, 1)).toBe(true);
    expect(shouldRetryBaselineFindings(hard, 2)).toBe(false);
    expect(shouldRetryBaselineFindings(advisory, 1)).toBe(false);
  });

  async function missingPrerequisite(provider: "openai" | "anthropic") {
    const findings: BaselineFindings = { regressions: [], warnings: [] };
    const summary = { [provider]: {} };
    const api = provider === "openai" ? "openai-responses" : "anthropic-messages";
    const message = "No " + provider + " " + api + " model available in registry.";
    const resolved = await resolveLiveCacheProviderPool({
      config: {
        provider,
        api,
        envVar:
          provider === "openai"
            ? "OPENCLAW_LIVE_OPENAI_CACHE_MODEL"
            : "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
        preferredModelIds: [provider === "openai" ? "gpt-5.5" : "claude-sonnet-4-6"],
      },
      resolver: async () => {
        throw new LiveCachePrerequisiteSkip(provider, message);
      },
      ...findings,
      summary,
    });
    expect(resolved).toBeUndefined();
    expect(summary[provider]).toEqual({ skipped: true });
    return { ...findings, message: provider + " skipped: " + message };
  }

  it.each(["openai", "anthropic"] as const)(
    "classifies missing %s prerequisites",
    async (provider) => {
      const { regressions, warnings, message } = await missingPrerequisite(provider);
      expect({ regressions, warnings }).toStrictEqual(
        provider === "openai"
          ? { regressions: [], warnings: [message] }
          : { regressions: [message], warnings: [] },
      );
    },
  );

  it("classifies missing provider auth as a live-cache prerequisite", () => {
    const skip = toLiveCachePrerequisiteSkip(
      "openai",
      new ProviderAuthError("missing-provider-auth", "openai", "No API key found."),
    );

    expect(skip).toBeInstanceOf(LiveCachePrerequisiteSkip);
    expect(skip).toMatchObject({ provider: "openai", message: "No API key found." });
  });

  it("retries a cache probe twice when provider text misses the sentinel", () => {
    const retry = (attempt: number, text = "") =>
      shouldRetryCacheProbeText({ attempt, text, suffix: "openai-stable-hit-a" });
    expect(retry(1)).toBe(true);
    expect(retry(2)).toBe(true);
    expect(retry(3)).toBe(false);
    expect(retry(1, "I saw openai-stable-hit-a.")).toBe(true);
    expect(retry(1, "CACHE-OK openai-stable-hit-a")).toBe(false);
  });

  it("keeps cache probes above the provider empty-output floor", () => {
    const tokens = (maxTokens: number, providerTag: "openai" | "anthropic" = "openai") =>
      resolveCacheProbeMaxTokens({ maxTokens, providerTag });
    expect(tokens(32)).toBe(1024);
    expect(tokens(512)).toBe(1024);
    expect(tokens(2048)).toBe(2048);
    expect(tokens(32, "anthropic")).toBe(1024);
  });

  it("classifies Anthropic tool-only probe misses as provider drift", () => {
    expect(isAnthropicToolProbeDrift(new Error("expected tool call for noop"))).toBe(true);
    expect(
      isAnthropicToolProbeDrift(new Error('expected tool-only response for noop, got "ok"')),
    ).toBe(true);
    expect(isAnthropicToolProbeDrift(new Error("other failure"))).toBe(false);
  });

  it("accepts empty cache probe text only when usage is observable", () => {
    const accept = (
      usage: Parameters<typeof shouldAcceptEmptyCacheProbe>[0]["usage"],
      text = "",
      providerTag: "openai" | "anthropic" = "openai",
    ) => shouldAcceptEmptyCacheProbe({ usage, text, providerTag });
    expect(accept({ input: 5_000 })).toBe(true);
    expect(accept({ cacheRead: 4_608 })).toBe(true);
    expect(accept({ input: 5_000 }, "wrong")).toBe(false);
    expect(accept({ input: 5_000 }, "", "anthropic")).toBe(true);
    expect(accept({})).toBe(false);
  });

  it.each([
    { hitRate: 0.999, usage: { cacheRead: 5_741, cacheWrite: 0, input: 3 }, regressions: [] },
    {
      hitRate: 0,
      usage: { cacheRead: 0, cacheWrite: 0, input: 5_741 },
      regressions: ["anthropic:image warmup cacheWrite=0 < min=1"],
    },
  ])(
    "requires cache evidence in the warmup ($hitRate hit rate)",
    ({ hitRate, usage, regressions }) => {
      const findings = evaluateAgainstBaseline({
        lane: "image",
        provider: "anthropic",
        result: {
          best: cacheRun({ cacheRead: 5_742, cacheWrite: 0, input: 3 }),
          warmup: cacheRun(usage, hitRate),
        },
      });

      expect(findings).toEqual({ regressions, warnings: [] });
    },
  );
});
