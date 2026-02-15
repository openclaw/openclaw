import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock pg before importing anything that uses it
vi.mock("pg", () => {
  class MockPool {
    query = vi.fn(async () => ({ rows: [] }));
    end = vi.fn(async () => {});
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

// Mock fetch globally
const mockFetch = vi.fn(async () => ({
  ok: true,
  json: async () => ({ success: true }),
}));
vi.stubGlobal("fetch", mockFetch);

import vmBridgePlugin from "./index.js";

describe("vm-bridge plugin", () => {
  it("has correct id, name, description", () => {
    expect(vmBridgePlugin.id).toBe("vm-bridge");
    expect(vmBridgePlugin.name).toBe("VM Bridge Orchestrator");
    expect(vmBridgePlugin.description).toContain("Orchestration");
  });

  it("has configSchema with parse and safeParse", () => {
    expect(typeof vmBridgePlugin.configSchema.parse).toBe("function");
    expect(typeof vmBridgePlugin.configSchema.safeParse).toBe("function");
  });

  it("registers 4 tools, 2 services, 1 hook, and CLI", () => {
    const registeredTools: unknown[] = [];
    const registeredServices: unknown[] = [];
    const registeredHooks: Record<string, unknown[]> = {};
    let cliRegistered = false;

    const mockApi = {
      pluginConfig: {
        database: { password: "test" },
        checkpoints: { selfEmail: "me@test.com" },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      registerTool: (tool: unknown, opts: unknown) => {
        registeredTools.push({ tool, opts });
      },
      registerService: (service: unknown) => {
        registeredServices.push(service);
      },
      on: (hookName: string, handler: unknown) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push(handler);
      },
      registerCli: (registrar: unknown, opts: unknown) => {
        cliRegistered = true;
      },
    } as any;

    vmBridgePlugin.register(mockApi);

    // 4 tools: contract_poll, contract_claim, contract_read, contract_update
    expect(registeredTools).toHaveLength(4);
    const toolNames = registeredTools.map((t: any) => t.tool.name);
    expect(toolNames).toContain("contract_poll");
    expect(toolNames).toContain("contract_claim");
    expect(toolNames).toContain("contract_read");
    expect(toolNames).toContain("contract_update");

    // All tools registered as optional
    for (const t of registeredTools as any[]) {
      expect(t.opts.optional).toBe(true);
    }

    // 2 services: vm-bridge-poller, vm-bridge-health
    expect(registeredServices).toHaveLength(2);
    const serviceIds = registeredServices.map((s: any) => s.id);
    expect(serviceIds).toContain("vm-bridge-poller");
    expect(serviceIds).toContain("vm-bridge-health");

    // 1 hook: message_received
    expect(registeredHooks["message_received"]).toHaveLength(1);

    // CLI registered
    expect(cliRegistered).toBe(true);

    // Logger called
    expect(mockApi.logger.info).toHaveBeenCalledWith("[vm-bridge] Extension registered");
  });

  it("registers vm-agent-loop service when hostname is configured", () => {
    const registeredServices: unknown[] = [];

    const mockApi = {
      pluginConfig: {
        database: { password: "test" },
        checkpoints: { selfEmail: "me@test.com" },
        agentLoop: { hostname: "vvg-gbp-ec2", pollIntervalMs: 15_000 },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      registerTool: vi.fn(),
      registerService: (service: unknown) => {
        registeredServices.push(service);
      },
      on: vi.fn(),
      registerCli: vi.fn(),
    } as any;

    vmBridgePlugin.register(mockApi);

    expect(registeredServices).toHaveLength(3);
    const serviceIds = registeredServices.map((s: any) => s.id);
    expect(serviceIds).toContain("vm-bridge-poller");
    expect(serviceIds).toContain("vm-bridge-health");
    expect(serviceIds).toContain("vm-agent-loop");
  });

  it("configSchema rejects invalid config", () => {
    const result = vmBridgePlugin.configSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("configSchema accepts valid config", () => {
    const result = vmBridgePlugin.configSchema.safeParse({
      database: { password: "test" },
      checkpoints: { selfEmail: "me@test.com" },
    });
    expect(result.success).toBe(true);
  });
});
