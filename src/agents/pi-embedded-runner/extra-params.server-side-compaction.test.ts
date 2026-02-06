import { beforeEach, describe, expect, it, vi } from "vitest";

// Must declare mock at module level for hoisting
vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }),
  }),
}));

import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

const mockStreamSimple = vi.mocked(streamSimple);

describe("server-side compaction", () => {
  beforeEach(() => {
    mockStreamSimple.mockClear();
    mockStreamSimple.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }),
    } as ReturnType<typeof streamSimple>);
  });

  it("does not apply server-side compaction when not configured", () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {};

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-5");

    // No streamFn wrapper should be applied
    expect(agent.streamFn).toBeUndefined();
  });

  it("does not apply server-side compaction when disabled", () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            serverSide: {
              enabled: false,
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-5");

    expect(agent.streamFn).toBeUndefined();
  });

  it("does not apply server-side compaction for non-anthropic providers", () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            serverSide: {
              enabled: true,
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-4o");

    expect(agent.streamFn).toBeUndefined();
  });

  it("applies server-side compaction with default strategy for anthropic provider", async () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            serverSide: {
              enabled: true,
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-5");

    expect(agent.streamFn).toBeDefined();

    // Call the wrapped streamFn to verify it passes correct options
    const wrappedFn = agent.streamFn as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => unknown;
    wrappedFn({}, {}, {});

    expect(mockStreamSimple).toHaveBeenCalledTimes(1);
    const [, , options] = mockStreamSimple.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];

    // Verify beta header is set
    expect(options.headers).toHaveProperty("anthropic-beta", "context-management-2025-06-27");

    // Verify context_management.edits with default strategy
    expect(options.extraBody).toHaveProperty("context_management");
    expect((options.extraBody as Record<string, unknown>).context_management).toEqual({
      edits: [{ type: "compact_20260112" }],
    });
  });

  it("applies server-side compaction with custom strategy", async () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            serverSide: {
              enabled: true,
              strategy: "custom_strategy_v2",
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-5");

    expect(agent.streamFn).toBeDefined();

    const wrappedFn = agent.streamFn as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => unknown;
    wrappedFn({}, {}, {});

    const [, , options] = mockStreamSimple.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];

    expect((options.extraBody as Record<string, unknown>).context_management).toEqual({
      edits: [{ type: "custom_strategy_v2" }],
    });
  });

  it("appends to existing anthropic-beta header", async () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            serverSide: {
              enabled: true,
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-5");

    const wrappedFn = agent.streamFn as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => unknown;

    // Call with existing beta header
    wrappedFn({}, {}, { headers: { "anthropic-beta": "existing-feature" } });

    const [, , options] = mockStreamSimple.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];

    // Verify beta headers are combined
    expect((options.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "existing-feature,context-management-2025-06-27",
    );
  });

  it("preserves existing extraBody properties", async () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            serverSide: {
              enabled: true,
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-5");

    const wrappedFn = agent.streamFn as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => unknown;

    // Call with existing extraBody
    wrappedFn({}, {}, { extraBody: { custom_param: "value" } });

    const [, , options] = mockStreamSimple.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];

    // Verify existing extraBody is preserved
    expect(options.extraBody).toHaveProperty("custom_param", "value");
    expect(options.extraBody).toHaveProperty("context_management");
  });

  it("works with other extra params like temperature", async () => {
    const agent: { streamFn?: unknown } = {};
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {
              params: {
                temperature: 0.7,
              },
            },
          },
          compaction: {
            serverSide: {
              enabled: true,
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-5");

    expect(agent.streamFn).toBeDefined();

    const wrappedFn = agent.streamFn as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => unknown;
    wrappedFn({}, {}, {});

    // The outer wrapper (server-side compaction) calls the inner wrapper (temperature)
    // which then calls mockStreamSimple
    expect(mockStreamSimple).toHaveBeenCalled();
    const [, , options] = mockStreamSimple.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];

    // Verify server-side compaction options
    expect(options.headers).toHaveProperty("anthropic-beta", "context-management-2025-06-27");
    expect(options.extraBody).toHaveProperty("context_management");
  });
});
