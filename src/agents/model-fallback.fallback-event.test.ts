import { describe, expect, it, vi } from "vitest";
import { drainSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { runWithModelFallback } from "./model-fallback.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

const SESSION_KEY = "test:fallback-event";
const makeCfg = makeModelFallbackCfg;

describe("runWithModelFallback – system event injection", () => {
  it("enqueues a system event when fallback succeeds", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      sessionKey: SESSION_KEY,
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-3-5");

    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("Model fallback:");
    expect(events[0]).toContain("openai/gpt-4.1-mini");
    expect(events[0]).toContain("anthropic/claude-haiku-3-5");
    expect(events[0]).toContain("rate_limit");
  });

  it("does not enqueue event when primary succeeds (no fallback)", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg();
    const run = vi.fn().mockResolvedValueOnce("ok");

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      sessionKey: SESSION_KEY,
      run,
    });

    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(0);
  });

  it("does not enqueue event when sessionKey is not provided", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    // No sessionKey → no event
    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(0);
  });

  it("includes auth reason when fallback is due to auth error", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }))
      .mockResolvedValueOnce("ok");

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      sessionKey: SESSION_KEY,
      run,
    });

    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("(reason: auth)");
  });

  it("includes timeout reason when fallback is due to timeout", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { status: 504 }))
      .mockResolvedValueOnce("ok");

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      sessionKey: SESSION_KEY,
      run,
    });

    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("(reason: timeout)");
  });

  it("includes unknown reason for unrecognized errors", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("something weird"))
      .mockResolvedValueOnce("ok");

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      sessionKey: SESSION_KEY,
      run,
    });

    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("(reason: unknown)");
  });

  it("enqueues event with correct models for custom fallback chain", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5", "openrouter/deepseek-chat"],
          },
        },
      },
    });

    // Primary fails, first fallback fails, second fallback succeeds.
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("billing"), { status: 402 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      sessionKey: SESSION_KEY,
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("openrouter/deepseek-chat");

    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(1);
    // Event should reference the primary and the successful fallback
    expect(events[0]).toContain("openai/gpt-4.1-mini");
    expect(events[0]).toContain("openrouter/deepseek-chat");
  });

  it("does not enqueue event when all candidates fail", async () => {
    resetSystemEventsForTest();
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("also down"), { status: 503 }));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        sessionKey: SESSION_KEY,
        fallbacksOverride: [],
        run,
      }),
    ).rejects.toThrow();

    const events = drainSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(0);
  });
});
