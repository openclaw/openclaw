import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { CatalogParamsError } from "./session-catalog-parsing.js";
import { CodexCatalogSourceBackoff } from "./session-catalog-source-backoff.js";

describe("Codex catalog source backoff", () => {
  it("bounds retries, permits one recovery probe, and resets the schedule on success", () => {
    let now = 0;
    const backoff = new CodexCatalogSourceBackoff(() => now);
    const config = {};
    const failure = new Error("unavailable");
    const begin = () => backoff.begin(config, "main", "home");
    const start = () => {
      const attempt = begin();
      assert(attempt.allowed);
      return attempt;
    };
    start().rejected(failure);
    start().rejected(failure);
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      now += delay - 1;
      expect(begin()).toEqual({ allowed: false, error: failure });
      now += 1;
      const probe = start();
      expect(begin()).toEqual({ allowed: false, error: failure });
      probe.rejected(failure);
    }
    now += 60_000;
    start().resolved();
    start().rejected(failure);
    start().rejected(failure);
    now += 5_000;
    start().resolved();
  });

  it("partitions source health by config identity, agent, and home", () => {
    const config = {};
    const backoff = new CodexCatalogSourceBackoff(() => 0);
    const failure = new Error("unavailable");
    for (let index = 0; index < 2; index++) {
      const attempt = backoff.begin(config, "main", "home");
      assert(attempt.allowed);
      attempt.rejected(failure);
    }
    expect(backoff.begin(config, "main", "home")).toEqual({ allowed: false, error: failure });
    expect(backoff.begin({ ...config }, "main", "home").allowed).toBe(true);
    expect(backoff.begin(config, "research", "home").allowed).toBe(true);
    expect(backoff.begin(config, "main", "other-home").allowed).toBe(true);
  });

  it("does not turn invalid catalog parameters into source failures", () => {
    const config = {};
    const backoff = new CodexCatalogSourceBackoff(() => 0);
    for (let index = 0; index < 3; index++) {
      const attempt = backoff.begin(config, "main", "home");
      assert(attempt.allowed);
      attempt.rejected(new CatalogParamsError("invalid cursor"));
    }
    expect(backoff.begin(config, "main", "home").allowed).toBe(true);
  });
});
