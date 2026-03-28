import { describe, expect, it } from "vitest";
import { computeBackoff } from "../../infra/backoff.js";
import {
  DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MAX_MS,
  OVERLOAD_FAILOVER_BACKOFF_INITIAL_MS,
  resolveOverloadFailoverBackoffPolicy,
} from "./run/helpers.js";

describe("resolveOverloadFailoverBackoffPolicy", () => {
  it("defaults the ceiling to 30s", () => {
    const policy = {
      ...resolveOverloadFailoverBackoffPolicy(),
      jitter: 0,
    };

    expect(policy.maxMs).toBe(DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MAX_MS);
    expect(computeBackoff(policy, 8)).toBe(DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MAX_MS);
  });

  it("respects a configured ceiling override", () => {
    const policy = {
      ...resolveOverloadFailoverBackoffPolicy(500),
      jitter: 0,
    };

    expect(policy.maxMs).toBe(500);
    expect(computeBackoff(policy, 2)).toBe(500);
    expect(computeBackoff(policy, 10)).toBe(500);
  });

  it("clamps invalid or undersized values to the initial delay floor", () => {
    expect(resolveOverloadFailoverBackoffPolicy(Number.NaN).maxMs).toBe(
      DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MAX_MS,
    );
    expect(resolveOverloadFailoverBackoffPolicy(-1).maxMs).toBe(
      OVERLOAD_FAILOVER_BACKOFF_INITIAL_MS,
    );
    expect(resolveOverloadFailoverBackoffPolicy(10).maxMs).toBe(
      OVERLOAD_FAILOVER_BACKOFF_INITIAL_MS,
    );
  });
});
