import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveCompactionFallbackCandidates } from "./compaction-fallback.js";

describe("resolveCompactionFallbackCandidates", () => {
  const current = { currentProvider: "anthropic", currentModel: "claude-sonnet-4-6" };

  it("returns [] with no config", () => {
    expect(resolveCompactionFallbackCandidates({ ...current })).toEqual([]);
  });

  it("returns [] when fallbackModel is absent", () => {
    const cfg = {
      agents: { defaults: { compaction: {} } },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionFallbackCandidates({ cfg, ...current })).toEqual([]);
  });

  it('returns [] when fallbackModel is "off"', () => {
    const cfg = {
      agents: { defaults: { compaction: { fallbackModel: "off" } } },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionFallbackCandidates({ cfg, ...current })).toEqual([]);
  });

  it('"fallback" returns candidates from model.fallbacks', () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: { fallbackModel: "fallback" },
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["anthropic/claude-haiku-4-5"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionFallbackCandidates({ cfg, ...current })).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ]);
  });

  it('"fallback" filters out the current model if it appears in fallbacks', () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: { fallbackModel: "fallback" },
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveCompactionFallbackCandidates({
        cfg,
        currentProvider: "anthropic",
        currentModel: "claude-sonnet-4-6",
      }),
    ).toEqual([{ provider: "anthropic", model: "claude-haiku-4-5" }]);
  });

  it('"fallback" returns [] when model.fallbacks is empty', () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: { fallbackModel: "fallback" },
          model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionFallbackCandidates({ cfg, ...current })).toEqual([]);
  });
});
