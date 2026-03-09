import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("a2a plugin", () => {
  it("has correct metadata", () => {
    expect(plugin.id).toBe("a2a");
    expect(plugin.name).toBe("A2A Gateway");
    expect(plugin.description).toContain("A2A");
  });

  it("has a config schema with parse method", () => {
    expect(plugin.configSchema).toBeDefined();
    expect(typeof plugin.configSchema.parse).toBe("function");
  });

  it("does not register anything when disabled", () => {
    const registerHttpRoute = vi.fn();
    const registerTool = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerService = vi.fn();
    const registerCli = vi.fn();

    plugin.register({
      id: "a2a",
      name: "A2A Gateway",
      description: "test",
      source: "test",
      pluginConfig: { enabled: false },
      config: {},
      runtime: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool,
      registerHook: vi.fn(),
      registerHttpRoute,
      registerChannel: vi.fn(),
      registerGatewayMethod,
      registerCli,
      registerService,
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: (input: string) => input,
      on: vi.fn(),
      registerContextEngine: vi.fn(),
    });

    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerGatewayMethod).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(registerCli).not.toHaveBeenCalled();
  });

  it("registers all components when enabled", () => {
    const registerHttpRoute = vi.fn();
    const registerTool = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerService = vi.fn();
    const registerCli = vi.fn();

    plugin.register({
      id: "a2a",
      name: "A2A Gateway",
      description: "test",
      source: "test",
      pluginConfig: { enabled: true },
      config: {},
      runtime: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool,
      registerHook: vi.fn(),
      registerHttpRoute,
      registerChannel: vi.fn(),
      registerGatewayMethod,
      registerCli,
      registerService,
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: (input: string) => input,
      on: vi.fn(),
      registerContextEngine: vi.fn(),
    });

    // HTTP routes: 2 Agent Card paths + 1 JSON-RPC endpoint = 3
    expect(registerHttpRoute).toHaveBeenCalledTimes(3);
    const routePaths = registerHttpRoute.mock.calls.map(
      (c: unknown[]) => (c[0] as { path: string }).path,
    );
    expect(routePaths).toContain("/.well-known/agent-card.json");
    expect(routePaths).toContain("/.well-known/agent.json");
    expect(routePaths).toContain("/a2a/jsonrpc");

    // 2 tools: a2a_discover, a2a_send
    expect(registerTool).toHaveBeenCalledTimes(2);
    const toolNames = registerTool.mock.calls.map(
      (c: unknown[]) => (c[1] as { name: string }).name,
    );
    expect(toolNames).toContain("a2a_discover");
    expect(toolNames).toContain("a2a_send");

    // Gateway methods: a2a.card, a2a.peers.list, a2a.peers.discover, a2a.peers.send, a2a.peers.check
    expect(registerGatewayMethod).toHaveBeenCalledTimes(5);
    const methodNames = registerGatewayMethod.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(methodNames).toContain("a2a.card");
    expect(methodNames).toContain("a2a.peers.list");
    expect(methodNames).toContain("a2a.peers.discover");
    expect(methodNames).toContain("a2a.peers.send");
    expect(methodNames).toContain("a2a.peers.check");

    // Service
    expect(registerService).toHaveBeenCalledTimes(1);

    // CLI
    expect(registerCli).toHaveBeenCalledTimes(1);
    const cliCall = registerCli.mock.calls[0] as unknown[];
    expect((cliCall[1] as { commands: string[] }).commands).toEqual(["a2a"]);
  });

  it("warns when bearer auth enabled but no token", () => {
    const warnFn = vi.fn();

    plugin.register({
      id: "a2a",
      name: "A2A Gateway",
      description: "test",
      source: "test",
      pluginConfig: { enabled: true, auth: { mode: "bearer" } },
      config: {},
      runtime: {} as never,
      logger: { info: vi.fn(), warn: warnFn, error: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: (input: string) => input,
      on: vi.fn(),
      registerContextEngine: vi.fn(),
    });

    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("bearer auth enabled but no token"),
    );
  });
});
