import { describe, expect, it } from "vitest";
import {
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

const emptyFindings = (): BaselineFindings => ({ regressions: [], warnings: [] });

describe("live cache regression runner", () => {
  const hit = cacheRun({ cacheRead: 5_742 });
  it.each([
    [
      "openai",
      "stable",
      { best: cacheRun({ input: 5_034 }, 0) },
      {
        regressions: [],
        warnings: [
          "openai:stable cacheRead=0 < min=4608",
          "openai:stable hitRate=0.000 < min=0.900",
        ],
      },
    ],
    ["anthropic", "image", { best: hit, warmup: cacheRun({ cacheRead: 5_741 }) }, emptyFindings()],
    [
      "anthropic",
      "image",
      { best: hit, warmup: cacheRun({ cacheRead: 0 }, 0) },
      {
        regressions: ["anthropic:image warmup cacheWrite=0 < min=1"],
        warnings: [],
      },
    ],
  ] as const)("classifies %s %s baseline evidence (%j)", (provider, lane, result, expected) => {
    expect(evaluateAgainstBaseline({ provider, lane, result })).toEqual(expected);
  });

  it("retries hard cache baseline misses once", () => {
    const hard = { regressions: ["anthropic:image cacheRead=0 < min=4500"], warnings: [] };
    const advisory = { regressions: [], warnings: ["openai:image cacheRead=0 < min=3840"] };
    expect(shouldRetryBaselineFindings(hard, 1)).toBe(true);
    expect(shouldRetryBaselineFindings(hard, 2)).toBe(false);
    expect(shouldRetryBaselineFindings(advisory, 1)).toBe(false);
  });

  it.each([
    ["openai", "openai-responses", "warnings"],
    ["anthropic", "anthropic-messages", "regressions"],
  ] as const)("classifies missing %s prerequisites", async (provider, api, severity) => {
    const result = emptyFindings();
    const summary = { [provider]: {} };
    const message = `No ${provider} ${api} model available in registry.`;
    const resolved = await resolveLiveCacheProviderPool({
      config: {
        provider,
        api,
        envVar: "UNUSED_MODEL",
        preferredModelIds: [],
      },
      resolver: async () => {
        throw new LiveCachePrerequisiteSkip(provider, message);
      },
      ...result,
      summary,
    });
    expect(resolved).toBeUndefined();
    expect(summary[provider]).toEqual({ skipped: true });
    expect(result).toStrictEqual({
      ...emptyFindings(),
      [severity]: [`${provider} skipped: ${message}`],
    });
  });

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
    const tokens = (maxTokens: number) =>
      resolveCacheProbeMaxTokens({ maxTokens, providerTag: "openai" });
    expect(tokens(32)).toBe(1024);
    expect(tokens(2048)).toBe(2048);
  });

  it("classifies Anthropic tool-only probe misses as provider drift", () => {
    expect(isAnthropicToolProbeDrift(new Error("expected tool call for noop"))).toBe(true);
    expect(
      isAnthropicToolProbeDrift(new Error('expected tool-only response for noop, got "ok"')),
    ).toBe(true);
    expect(isAnthropicToolProbeDrift(new Error("other failure"))).toBe(false);
  });

  it("accepts empty cache probe text only when usage is observable", () => {
    const accept = (usage: Parameters<typeof shouldAcceptEmptyCacheProbe>[0]["usage"], text = "") =>
      shouldAcceptEmptyCacheProbe({ usage, text, providerTag: "openai" });
    expect(accept({ input: 5_000 })).toBe(true);
    expect(accept({ cacheRead: 4_608 })).toBe(true);
    expect(accept({ input: 5_000 }, "wrong")).toBe(false);
    expect(accept({})).toBe(false);
  });
});
