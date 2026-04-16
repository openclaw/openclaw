import { describe, expect, it } from "vitest";
import { buildMemoryV2Rerank, readRerankOptions } from "./rerank-wiring.js";

describe("readRerankOptions", () => {
  it("defaults to disabled on null/undefined/non-object", () => {
    expect(readRerankOptions(null).enabled).toBe(false);
    expect(readRerankOptions(undefined).enabled).toBe(false);
    expect(readRerankOptions("on").enabled).toBe(false);
    expect(readRerankOptions(42).enabled).toBe(false);
  });

  it("defaults to disabled when memoryV2 or rerank is missing", () => {
    expect(readRerankOptions({}).enabled).toBe(false);
    expect(readRerankOptions({ memoryV2: {} }).enabled).toBe(false);
    expect(readRerankOptions({ memoryV2: { ingest: { enabled: true } } }).enabled).toBe(false);
  });

  it("requires enabled === true exactly", () => {
    expect(readRerankOptions({ memoryV2: { rerank: { enabled: false } } }).enabled).toBe(false);
    expect(readRerankOptions({ memoryV2: { rerank: { enabled: 1 } } }).enabled).toBe(false);
    expect(readRerankOptions({ memoryV2: { rerank: { enabled: "true" } } }).enabled).toBe(false);
    expect(readRerankOptions({ memoryV2: { rerank: { enabled: true } } }).enabled).toBe(true);
  });

  it("threads numeric overrides into cfg", () => {
    const out = readRerankOptions({
      memoryV2: {
        rerank: {
          enabled: true,
          salienceWeight: 0.7,
          recencyHalfLifeDays: 30,
          pinnedBoost: 2,
          supersededPenalty: 0.25,
        },
      },
    });
    expect(out.cfg.salienceWeight).toBe(0.7);
    expect(out.cfg.recencyHalfLifeDays).toBe(30);
    expect(out.cfg.pinnedBoost).toBe(2);
    expect(out.cfg.supersededPenalty).toBe(0.25);
  });

  it("ignores non-numeric overrides silently", () => {
    const out = readRerankOptions({
      memoryV2: {
        rerank: { enabled: true, salienceWeight: "x", recencyHalfLifeDays: null },
      },
    });
    expect(out.cfg.salienceWeight).toBeUndefined();
    expect(out.cfg.recencyHalfLifeDays).toBeUndefined();
  });

  it("threads shadowOnRecall as a boolean only", () => {
    expect(
      readRerankOptions({ memoryV2: { rerank: { enabled: true, shadowOnRecall: true } } })
        .shadowOnRecall,
    ).toBe(true);
    expect(
      readRerankOptions({ memoryV2: { rerank: { enabled: true, shadowOnRecall: 1 } } })
        .shadowOnRecall,
    ).toBe(false);
  });
});

describe("buildMemoryV2Rerank", () => {
  it("returns undefined when the flag is off (default)", () => {
    expect(buildMemoryV2Rerank({ pluginConfig: undefined })).toBeUndefined();
    expect(buildMemoryV2Rerank({ pluginConfig: {} })).toBeUndefined();
    expect(
      buildMemoryV2Rerank({ pluginConfig: { memoryV2: { rerank: { enabled: false } } } }),
    ).toBeUndefined();
  });

  it("returns a callable RerankFn when enabled", async () => {
    const fn = buildMemoryV2Rerank({
      pluginConfig: { memoryV2: { rerank: { enabled: true } } },
    });
    expect(typeof fn).toBe("function");
    // Identity behavior when no workspaceDir is provided (no db opened).
    const out = await fn?.(
      [{ source: "memory", path: "a.md", startLine: 1, endLine: 2, score: 0.5 }],
      {},
    );
    expect(out?.[0]?.score).toBe(0.5);
  });
});
