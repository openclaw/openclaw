import { describe, expect, it } from "vitest";
import { createEmbeddedFailoverRouter } from "./failover-router.js";

describe("createEmbeddedFailoverRouter", () => {
  it("opens a model circuit after repeated overloaded failures on the same model", () => {
    const router = createEmbeddedFailoverRouter();

    expect(
      router.route({
        provider: "openai",
        model: "gpt-5.4",
        profileId: "openai:p1",
        reason: "overloaded",
        canRotateProfile: true,
        fallbackConfigured: true,
      }),
    ).toMatchObject({
      decision: "rotate_profile",
      circuitOpen: false,
      failureCount: 1,
      threshold: 2,
      scope: "model",
    });

    expect(
      router.route({
        provider: "openai",
        model: "gpt-5.4",
        profileId: "openai:p2",
        reason: "overloaded",
        canRotateProfile: true,
        fallbackConfigured: true,
      }),
    ).toMatchObject({
      decision: "fallback_model",
      circuitOpen: true,
      failureCount: 2,
      threshold: 2,
      scope: "model",
    });
  });

  it("opens a model circuit after repeated timeout failures on the same model", () => {
    const router = createEmbeddedFailoverRouter();

    router.route({
      provider: "openai",
      model: "gpt-5.4",
      profileId: "openai:p1",
      reason: "timeout",
      canRotateProfile: true,
      fallbackConfigured: true,
    });

    expect(
      router.route({
        provider: "openai",
        model: "gpt-5.4",
        profileId: "openai:p2",
        reason: "timeout",
        canRotateProfile: true,
        fallbackConfigured: true,
      }),
    ).toMatchObject({
      decision: "fallback_model",
      circuitOpen: true,
      failureCount: 2,
      threshold: 2,
      scope: "model",
    });
  });

  it("keeps non-breaker reasons on profile rotation path", () => {
    const router = createEmbeddedFailoverRouter();

    expect(
      router.route({
        provider: "openai",
        model: "gpt-5.4",
        profileId: "openai:p1",
        reason: "rate_limit",
        canRotateProfile: true,
        fallbackConfigured: true,
      }),
    ).toMatchObject({
      decision: "rotate_profile",
      circuitOpen: false,
      failureCount: 1,
      threshold: null,
      scope: "profile",
    });
  });

  it("isolates model-level circuit counts by provider/model", () => {
    const router = createEmbeddedFailoverRouter();

    router.route({
      provider: "openai",
      model: "gpt-5.4",
      profileId: "openai:p1",
      reason: "overloaded",
      canRotateProfile: true,
      fallbackConfigured: true,
    });

    expect(
      router.route({
        provider: "openai",
        model: "gpt-5.2",
        profileId: "openai:p2",
        reason: "overloaded",
        canRotateProfile: true,
        fallbackConfigured: true,
      }),
    ).toMatchObject({
      decision: "rotate_profile",
      circuitOpen: false,
      failureCount: 1,
      threshold: 2,
      scope: "model",
    });
  });
});
