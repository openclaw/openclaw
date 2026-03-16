import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryCollector } from "../telemetry/collector.js";
import { registerSessionHooks } from "./session-hooks.js";

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

describe("registerSessionHooks", () => {
  it("records session_start with the stable session key", () => {
    const harness = createMockApiHarness();
    const collector = createMockCollector();

    registerSessionHooks(harness.api, collector);

    const sessionStart = harness.getHandler("session_start");
    sessionStart.handler(
      {
        sessionId: "s1",
        sessionKey: "sk1",
        resumedFrom: "s0",
      },
      {
        agentId: "a1",
      },
    );

    expect(collector.recordSessionStart).toHaveBeenCalledWith({
      sessionId: "s1",
      sessionKey: "sk1",
      resumedFrom: "s0",
      agentId: "a1",
    });
  });
});
