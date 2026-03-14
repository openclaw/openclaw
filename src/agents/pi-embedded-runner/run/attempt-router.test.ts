import { describe, expect, it } from "vitest";
import { createEmbeddedAttemptRouter } from "./attempt-router.js";

describe("createEmbeddedAttemptRouter", () => {
  it("opens an overloaded breaker after repeated failures and blocks preflight calls", () => {
    let now = 1_000;
    const router = createEmbeddedAttemptRouter({
      now: () => now,
    });

    expect(
      router.recordFailure({
        provider: "openai",
        model: "gpt-5.4",
        reason: "overloaded",
        status: 503,
        rawError: "provider overloaded",
      }),
    ).toMatchObject({
      circuitOpen: false,
      failureCount: 1,
      threshold: 2,
    });

    expect(
      router.recordFailure({
        provider: "openai",
        model: "gpt-5.4",
        reason: "overloaded",
        status: 503,
        rawError: "provider overloaded again",
      }),
    ).toMatchObject({
      circuitOpen: true,
      failureCount: 2,
      threshold: 2,
    });

    expect(
      router.inspect({
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toMatchObject({
      reason: "overloaded",
      status: 503,
      failureCount: 2,
      threshold: 2,
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("lets calls through again after the breaker TTL expires", () => {
    let now = 5_000;
    const router = createEmbeddedAttemptRouter({
      now: () => now,
      breakerTtlMs: {
        overloaded: 200,
      },
    });

    router.recordFailure({
      provider: "openai",
      model: "gpt-5.4",
      reason: "overloaded",
      status: 503,
      rawError: "provider overloaded",
    });
    router.recordFailure({
      provider: "openai",
      model: "gpt-5.4",
      reason: "overloaded",
      status: 503,
      rawError: "provider overloaded again",
    });

    expect(
      router.inspect({
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).not.toBeNull();

    now += 250;

    expect(
      router.inspect({
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toBeNull();
  });

  it("keeps breaker state isolated per provider/model", () => {
    const router = createEmbeddedAttemptRouter();

    router.recordFailure({
      provider: "openai",
      model: "gpt-5.4",
      reason: "timeout",
      status: 408,
      rawError: "timed out",
    });
    router.recordFailure({
      provider: "openai",
      model: "gpt-5.4",
      reason: "timeout",
      status: 408,
      rawError: "timed out again",
    });

    expect(
      router.inspect({
        provider: "openai",
        model: "gpt-5.2",
      }),
    ).toBeNull();
  });
});
