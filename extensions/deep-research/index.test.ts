import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("registers lazily and scans bounded recovery state without network, invokes with unavailable providers, and retires the service", async () => {
  const runtime = createPluginRuntimeMock();
  const open = vi.mocked(runtime.state.openKeyedStoreV2);
  const unexpected = async (): Promise<never> => {
    throw new Error("Startup attempted a state mutation");
  };
  open.mockImplementation(() => ({
    entries: async () => [],
    count: async () => 0,
    lookup: async () => undefined,
    lookupMany: async () => [],
    register: unexpected,
    registerIfAbsent: unexpected,
    consume: unexpected,
    delete: unexpected,
    clear: unexpected,
    observe: unexpected,
    compareAndApply: unexpected,
    deleteIfEqual: unexpected,
    entriesInKeyRange: async () => [],
    moveEntriesFrom: unexpected,
  }));
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const api = createTestPluginApi({ id: "deep-research", runtime, registerTool, registerService });
  const scheduler = createTestPluginServiceScheduler();
  try {
    plugin.register(api);
    const serviceRegistration = registerService.mock.calls.at(0);
    const toolRegistration = registerTool.mock.calls.at(0);
    assert.ok(serviceRegistration && toolRegistration);
    const service = serviceRegistration[0];
    const factory = toolRegistration[0];
    if (service.apiVersion !== 3 || typeof factory !== "object" || !("create" in factory)) {
      throw new Error("Expected versioned registrations");
    }
    const serviceContext = {
      sessionWork: {
        version: 1 as const,
        withCurrent: unexpected,
        admit: unexpected,
        run: unexpected,
      },
      scheduler,
      config: {},
      stateDir: "/unused-research-state",
      logger: api.logger,
    };
    await service.start(serviceContext);
    expect(open).toHaveBeenCalledTimes(1);
    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.gateway.request).not.toHaveBeenCalled();
    expect(toolRegistration[1]?.optional).not.toBe(true);
    const current = vi.fn();
    const tool = factory.create({
      agentId: "main",
      sessionKey: "agent:main:research-fixture",
      sessionId: "generation-1",
      assertInvocationCurrent: current,
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one tool");
    }
    vi.mocked(runtime.gateway.request).mockRejectedValue(new Error("method unavailable"));
    const response = await tool.execute("capabilities", { action: "capabilities" });
    expect(response.details).toMatchObject({
      portable: { nativeFunctionCallingRequired: false },
      managed: { available: false },
    });
    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    await service.stop?.(serviceContext);
    await scheduler.stop();
    await expect(tool.execute("retired", { action: "capabilities" })).rejects.toThrow(
      "running Gateway",
    );
    expect(runtime.gateway.request).toHaveBeenCalledTimes(1);
  } finally {
    await scheduler.stop();
  }
});
