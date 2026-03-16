import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryCollector } from "../telemetry/collector.js";
import { registerModelHooks } from "./model-hooks.js";

type GenericHookHandler = (event: unknown, ctx: unknown) => unknown;

type HookRegistration = {
  handler: GenericHookHandler;
  opts?: { priority?: number };
};

function createMockCollector(): TelemetryCollector {
  return {
    recordSessionStart: vi.fn(),
    recordSessionEnd: vi.fn(),
    recordGatewayStart: vi.fn(),
    recordGatewayStop: vi.fn(),
    recordToolCallFinished: vi.fn(),
    recordModelResponseUsage: vi.fn(),
    recordMappedEvent: vi.fn(),
  };
}

function createMockApiHarness() {
  const handlers = new Map<string, HookRegistration[]>();

  const api = {
    on: vi.fn((hookName: string, handler: GenericHookHandler, opts?: { priority?: number }) => {
      const list = handlers.get(hookName) ?? [];
      list.push({ handler, opts });
      handlers.set(hookName, list);
    }),
  } as unknown as OpenClawPluginApi;

  function getHandler(hookName: string): HookRegistration {
    const list = handlers.get(hookName) ?? [];
    const first = list[0];
    expect(first).toBeDefined();
    return first as HookRegistration;
  }

  return { api, getHandler };
}

describe("registerModelHooks", () => {
  it("registers only llm_output for terminal model usage", () => {
    const harness = createMockApiHarness();
    const collector = createMockCollector();

    registerModelHooks(harness.api, collector);

    expect(harness.api.on).toHaveBeenCalledTimes(1);
    expect(harness.api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
  });

  it("records llm_output as model response usage", () => {
    const harness = createMockApiHarness();
    const collector = createMockCollector();

    registerModelHooks(harness.api, collector);

    const llmOutput = harness.getHandler("llm_output");
    llmOutput.handler(
      {
        runId: "run-2",
        provider: "openai",
        model: "gpt-4.1",
        sessionId: "s2",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      },
      {
        agentId: "a2",
      },
    );

    expect(collector.recordModelResponseUsage).toHaveBeenCalledWith({
      runId: "run-2",
      provider: "openai",
      model: "gpt-4.1",
      agentId: "a2",
      sessionId: "s2",
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
    });
  });
});
