import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryCollector } from "../telemetry/collector.js";
import { registerToolHooks } from "./tool-hooks.js";

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

describe("registerToolHooks", () => {
  it("registers only after_tool_call", () => {
    const harness = createMockApiHarness();
    const collector = createMockCollector();

    registerToolHooks(harness.api, collector);

    expect(harness.api.on).toHaveBeenCalledTimes(1);
    expect(harness.api.on).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
  });

  it("records finished tool calls", () => {
    const harness = createMockApiHarness();
    const collector = createMockCollector();

    registerToolHooks(harness.api, collector);

    const after = harness.getHandler("after_tool_call");
    after.handler(
      {
        toolName: "read",
        durationMs: 25,
        error: "file not found",
      },
      {
        agentId: "a2",
        sessionKey: "sk2",
      },
    );

    expect(collector.recordToolCallFinished).toHaveBeenCalledWith({
      toolName: "read",
      durationMs: 25,
      error: "file not found",
      agentId: "a2",
      sessionKey: "sk2",
    });
  });
});
