import { describe, expect, it } from "vitest";
import { applyRerank, mergeDefaults, recencyMultiplier, rescore } from "./score.js";
import type { RerankSignals, RerankableResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const baseResult: RerankableResult = {
  source: "memory",
  path: "memory/a.md",
  startLine: 1,
  endLine: 5,
  score: 1,
};

const neutralSignals: RerankSignals = {
  salience: 0.5,
  pinned: false,
  status: "active",
  lastAccessedAt: null,
};

describe("mergeDefaults", () => {
  it("fills omitted fields with documented defaults", () => {
    const cfg = mergeDefaults(undefined);
    expect(cfg.salienceWeight).toBe(0.5);
    expect(cfg.recencyHalfLifeDays).toBe(14);
    expect(cfg.pinnedBoost).toBe(1);
    expect(cfg.supersededPenalty).toBe(0.5);
    expect(cfg.recencyFloor).toBe(0.25);
    expect(cfg.defaultSalience).toBe(0.5);
  });

  it("respects caller overrides", () => {
    const cfg = mergeDefaults({ salienceWeight: 0, pinnedBoost: 5 });
    expect(cfg.salienceWeight).toBe(0);
    expect(cfg.pinnedBoost).toBe(5);
    expect(cfg.recencyHalfLifeDays).toBe(14);
  });
});

describe("recencyMultiplier", () => {
  const cfg = mergeDefaults({});

  it("returns 1 when lastAccessedAt is null", () => {
    expect(recencyMultiplier(null, cfg, 1_000_000)).toBe(1);
  });

  it("returns 1 at age 0", () => {
    expect(recencyMultiplier(1_000_000, cfg, 1_000_000)).toBe(1);
  });

  it("returns 0.5 at exactly one half-life", () => {
    const now = 1_000_000_000;
    const t = now - 14 * DAY_MS;
    expect(recencyMultiplier(t, cfg, now)).toBeCloseTo(0.5);
  });

  it("clamps at the recencyFloor for very old rows", () => {
    const now = 1_000_000_000;
    const t = now - 10 * 365 * DAY_MS;
    expect(recencyMultiplier(t, cfg, now)).toBe(cfg.recencyFloor);
  });

  it("returns 1 when half-life is 0 (decay disabled)", () => {
    const off = mergeDefaults({ recencyHalfLifeDays: 0 });
    expect(recencyMultiplier(1, off, 1_000_000)).toBe(1);
  });
});

describe("rescore", () => {
  const cfg = mergeDefaults({});
  const now = 1_000_000_000;

  it("equals base when signals are neutral and recency is null", () => {
    // salienceWeight=0.5, defaultSalience=0.5 → mul = 1.25, not 1.
    // Use an explicit zero salience weight test for true identity.
    const idCfg = mergeDefaults({ salienceWeight: 0 });
    expect(rescore(2, neutralSignals, idCfg, now)).toBe(2);
  });

  it("applies pinned boost", () => {
    const out = rescore(1, { ...neutralSignals, pinned: true }, cfg, now);
    // base 1 * (1 + 0.5*0.5) * 1 (no recency) * (1 + 1.0) * 1 = 1.25 * 2 = 2.5
    expect(out).toBeCloseTo(2.5);
  });

  it("applies supersession penalty", () => {
    const out = rescore(1, { ...neutralSignals, status: "superseded" }, cfg, now);
    // base 1 * 1.25 * 1 * 1 * (1 - 0.5) = 0.625
    expect(out).toBeCloseTo(0.625);
  });

  it("uses defaultSalience when salience is null", () => {
    const a = rescore(1, { ...neutralSignals, salience: null }, cfg, now);
    const b = rescore(1, { ...neutralSignals, salience: 0.5 }, cfg, now);
    expect(a).toBeCloseTo(b);
  });

  it("salience boost is monotonic", () => {
    const lo = rescore(1, { ...neutralSignals, salience: 0 }, cfg, now);
    const md = rescore(1, { ...neutralSignals, salience: 0.5 }, cfg, now);
    const hi = rescore(1, { ...neutralSignals, salience: 1 }, cfg, now);
    expect(md).toBeGreaterThan(lo);
    expect(hi).toBeGreaterThan(md);
  });

  it("max swing under defaults stays within documented bounds", () => {
    const maxBoost = rescore(
      1,
      { salience: 1, pinned: true, status: "active", lastAccessedAt: now },
      cfg,
      now,
    );
    expect(maxBoost).toBeLessThanOrEqual(3.001);

    const maxPenalty = rescore(
      1,
      { salience: 0, pinned: false, status: "superseded", lastAccessedAt: now - 365 * DAY_MS },
      cfg,
      now,
    );
    expect(maxPenalty).toBeGreaterThanOrEqual(0.124); // 1 * 1 * floor(0.25) * 1 * 0.5 = 0.125
    expect(maxPenalty).toBeLessThanOrEqual(0.126);
  });
});

describe("applyRerank", () => {
  const cfg = mergeDefaults({});
  const now = 1_000_000_000;
  const locationIdOf = (r: RerankableResult) => `${r.source}|${r.path}|${r.startLine}|${r.endLine}`;

  it("returns identity (byte-equal scores) when signals map is empty", () => {
    const results = [
      { ...baseResult, path: "a.md", score: 0.9 },
      { ...baseResult, path: "b.md", score: 0.4 },
    ];
    const out = applyRerank({
      results,
      signalsByLocation: new Map(),
      locationIdOf,
      cfg,
      now,
    });
    expect(out.map((r) => r.score)).toEqual([0.9, 0.4]);
  });

  it("preserves input length and field set, only mutates score", () => {
    const results = [{ ...baseResult, score: 0.7 }];
    const signals = new Map([[locationIdOf(results[0]), { ...neutralSignals, pinned: true }]]);
    const out = applyRerank({ results, signalsByLocation: signals, locationIdOf, cfg, now });
    expect(out.length).toBe(1);
    expect(out[0]?.path).toBe(results[0]?.path);
    expect(out[0]?.startLine).toBe(results[0]?.startLine);
    expect(out[0]?.score).not.toBe(results[0]?.score);
  });

  it("returns a new array of new objects (no in-place mutation)", () => {
    const results = [{ ...baseResult, score: 0.7 }];
    const signals = new Map([[locationIdOf(results[0]), { ...neutralSignals, pinned: true }]]);
    const out = applyRerank({ results, signalsByLocation: signals, locationIdOf, cfg, now });
    expect(out).not.toBe(results);
    expect(out[0]).not.toBe(results[0]);
    expect(results[0]?.score).toBe(0.7); // unchanged
  });

  it("applies signals only to results whose location is in the map", () => {
    const a = { ...baseResult, path: "a.md", score: 1 };
    const b = { ...baseResult, path: "b.md", score: 1 };
    const signals = new Map([[locationIdOf(a), { ...neutralSignals, pinned: true }]]);
    const out = applyRerank({
      results: [a, b],
      signalsByLocation: signals,
      locationIdOf,
      cfg,
      now,
    });
    expect(out[0]?.score).toBeGreaterThan(out[1]?.score ?? Infinity);
    expect(out[1]?.score).toBe(1);
  });
});
