/**
 * Tests for ingress model usage accounting in agentCommandFromIngress.
 *
 * Covers:
 * - ingressModelUsageChannel channel label resolution
 * - recordIngressModelUsage with model usage accounting enabled + valid usage
 * - recordIngressModelUsage with model usage accounting disabled
 * - recordIngressModelUsage with null/missing usage
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitModelUsageEvent: vi.fn(),
  shouldEmitModelUsageEvent: vi.fn(),
  getRuntimeConfig: vi.fn(),
  hasNonzeroUsage: vi.fn(),
  resolveModelCostConfig: vi.fn(),
  estimateUsageCost: vi.fn(),
}));

vi.mock("../infra/model-usage-events.js", () => ({
  emitModelUsageEvent: mocks.emitModelUsageEvent,
  shouldEmitModelUsageEvent: mocks.shouldEmitModelUsageEvent,
}));

vi.mock("../utils/usage-format.js", () => ({
  resolveModelCostConfig: (...args: Array<unknown>) => mocks.resolveModelCostConfig(...args),
  estimateUsageCost: (...args: Array<unknown>) => mocks.estimateUsageCost(...args),
}));

vi.mock("./usage.js", () => ({
  hasNonzeroUsage: (usage: unknown) => mocks.hasNonzeroUsage(usage),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => mocks.getRuntimeConfig(),
}));

let testing: typeof import("./agent-command.js").testing;

beforeAll(async () => {
  const mod = await import("./agent-command.js");
  testing = mod.testing;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shouldEmitModelUsageEvent.mockReturnValue(true);
  mocks.hasNonzeroUsage.mockReturnValue(true);
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.resolveModelCostConfig.mockReturnValue({});
  mocks.estimateUsageCost.mockReturnValue(0.001);
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeResult(overrides?: Record<string, unknown>) {
  return {
    payloads: [{ text: "hello", mediaUrl: "" }],
    meta: {
      durationMs: 1234,
      aborted: false,
      stopReason: "end_turn",
      agentMeta: {
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "sess-abc",
        usage: {
          input: 500,
          output: 200,
          cacheRead: 50,
          cacheWrite: 25,
          total: 775,
        },
        contextTokens: 128000,
        promptTokens: 1200,
        lastCallUsage: { input: 500, output: 200 },
        ...(overrides?.agentMeta as Record<string, unknown> | undefined),
      },
      ...(overrides?.meta as Record<string, unknown> | undefined),
    },
    ...overrides,
  };
}

function makeOpts(overrides?: Record<string, unknown>) {
  return {
    message: "hello",
    sessionKey: "agent:main:main",
    agentId: "main",
    allowModelOverride: false,
    messageChannel: "api",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ingressModelUsageChannel
// ---------------------------------------------------------------------------
describe("ingressModelUsageChannel", () => {
  it("returns runContext.messageChannel when set", () => {
    const channel = testing.ingressModelUsageChannel({
      message: "hi",
      allowModelOverride: false,
      runContext: { messageChannel: "discord" },
      messageChannel: "api",
      channel: "http",
    });
    expect(channel).toBe("discord");
  });

  it("falls back to opts.messageChannel", () => {
    const channel = testing.ingressModelUsageChannel({
      message: "hi",
      allowModelOverride: false,
      messageChannel: "api",
      channel: "http",
    });
    expect(channel).toBe("api");
  });

  it("falls back to opts.channel", () => {
    const channel = testing.ingressModelUsageChannel({
      message: "hi",
      allowModelOverride: false,
      channel: "webchat",
    });
    expect(channel).toBe("webchat");
  });

  it('defaults to "http" when no channel info is present', () => {
    const channel = testing.ingressModelUsageChannel({
      message: "hi",
      allowModelOverride: false,
    });
    expect(channel).toBe("http");
  });
});

// ---------------------------------------------------------------------------
// recordIngressModelUsage
// ---------------------------------------------------------------------------
describe("recordIngressModelUsage", () => {
  it("emits model.usage when usage accounting is enabled and result has usage", () => {
    const result = makeResult();
    const opts = makeOpts();

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
    const [configArg, event] = mocks.emitModelUsageEvent.mock.calls[0] ?? [];
    expect(configArg).toEqual({});
    expect(event).toMatchObject({
      sessionKey: "agent:main:main",
      sessionId: "sess-abc",
      channel: "api",
      agentId: "main",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 500,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
        promptTokens: 575,
        total: 775,
      },
      durationMs: 1234,
    });
  });

  it("does not emit when model usage accounting is disabled", () => {
    mocks.shouldEmitModelUsageEvent.mockReturnValue(false);
    const result = makeResult();
    const opts = makeOpts();

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("does not emit when agentMeta is missing", () => {
    const result = makeResult({
      meta: { durationMs: 100, aborted: false, stopReason: "end_turn" },
    });
    // result.meta.agentMeta is undefined
    (result as Record<string, unknown>).meta = { durationMs: 100 };

    const opts = makeOpts();

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("does not emit when usage is zero", () => {
    mocks.hasNonzeroUsage.mockReturnValue(false);
    const result = makeResult();
    const opts = makeOpts();

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("resolves channel from runContext when available", () => {
    const result = makeResult();
    const opts = makeOpts({
      runContext: { messageChannel: "discord" },
      messageChannel: "api",
    });

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitModelUsageEvent.mock.calls[0]?.[1];
    expect(event.channel).toBe("discord");
  });

  it('defaults channel to "http" when no channel info is present', () => {
    const result = makeResult();
    const opts = { message: "hi", allowModelOverride: false };

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitModelUsageEvent.mock.calls[0]?.[1];
    expect(event.channel).toBe("http");
  });

  it("computes cost when billable usage buckets are present", () => {
    const result = makeResult();
    const opts = makeOpts();

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.resolveModelCostConfig).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.5",
      config: expect.any(Object) as unknown,
    });
    expect(mocks.estimateUsageCost).toHaveBeenCalled();
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitModelUsageEvent.mock.calls[0]?.[1];
    expect(event.costUsd).toBe(0.001);
  });

  it("handles missing optional usage fields gracefully", () => {
    const result = makeResult({
      agentMeta: {
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "sess-min",
        usage: { input: 100, output: 50 },
      },
    });
    const opts = makeOpts();

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitModelUsageEvent.mock.calls[0]?.[1];
    expect(event.usage).toMatchObject({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 100,
      total: 150,
    });
  });

  it("omits context.used when promptTokens is undefined", () => {
    const result = makeResult({
      agentMeta: {
        promptTokens: undefined,
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "sess-no-prompt",
        usage: { input: 10, output: 5 },
        contextTokens: 128000,
      },
    });
    const opts = makeOpts();

    testing.recordIngressModelUsage(result, opts);

    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
    const event = mocks.emitModelUsageEvent.mock.calls[0]?.[1];
    expect(event.context).toEqual({ limit: 128000 });
  });
});
