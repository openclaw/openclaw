import { describe, expect, it } from "vitest";
import { __testing } from "./live-cache-regression-runner.js";

describe("live cache regression runner", () => {
  it("keeps OpenAI image cache floors observable without blocking release validation", () => {
    const regressions: string[] = [];
    const warnings: string[] = [];

    __testing.assertAgainstBaseline({
      lane: "image",
      provider: "openai",
      result: {
        best: {
          hitRate: 0,
          suffix: "image-hit",
          text: "CACHE-OK image-hit",
          usage: { cacheRead: 0, cacheWrite: 0, input: 5_096 },
        },
      },
      regressions,
      warnings,
    });

    expect(regressions).toEqual([]);
    expect(warnings).toEqual([
      "openai:image cacheRead=0 < min=3840",
      "openai:image hitRate=0.000 < min=0.820",
    ]);
  });

  it("keeps hard cache floors blocking for required OpenAI lanes", () => {
    const regressions: string[] = [];
    const warnings: string[] = [];

    __testing.assertAgainstBaseline({
      lane: "stable",
      provider: "openai",
      result: {
        best: {
          hitRate: 0,
          suffix: "stable-hit",
          text: "CACHE-OK stable-hit",
          usage: { cacheRead: 0, cacheWrite: 0, input: 5_034 },
        },
      },
      regressions,
      warnings,
    });

    expect(regressions).toEqual([
      "openai:stable cacheRead=0 < min=4608",
      "openai:stable hitRate=0.000 < min=0.900",
    ]);
    expect(warnings).toEqual([]);
  });
});
