import { describe, expect, it, vi } from "vitest";

describe("insta360 plugin registration", () => {
  it("registers tool, command, and service", async () => {
    const api = {
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolvePath: (p: string) => p.replace("~", "/home/test"),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerService: vi.fn(),
    };

    const { default: register } = await import("./index.js");
    register(api as any);

    expect(api.registerTool).toHaveBeenCalledOnce();
    expect(api.registerTool.mock.calls[0][0].name).toBe("insta360_camera");

    expect(api.registerCommand).toHaveBeenCalledOnce();
    expect(api.registerCommand.mock.calls[0][0].name).toBe("cam");

    expect(api.registerService).toHaveBeenCalledOnce();
    expect(api.registerService.mock.calls[0][0].id).toBe("insta360-monitor");
  });

  it("tool schema matches snapshot", async () => {
    const api = {
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolvePath: (p: string) => p.replace("~", "/home/test"),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerService: vi.fn(),
    };

    const { default: register } = await import("./index.js");
    register(api as any);

    const schema = api.registerTool.mock.calls[0][0].parameters;
    expect(JSON.parse(JSON.stringify(schema))).toMatchSnapshot();
  });
});
