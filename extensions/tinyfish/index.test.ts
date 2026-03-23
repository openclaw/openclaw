import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("tinyfish plugin registration", () => {
  it("registers only the tinyfish_automation tool", () => {
    const registerTool = vi.fn();

    plugin.register?.({
      id: "tinyfish",
      name: "TinyFish",
      description: "TinyFish",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool,
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      registerContextEngine() {},
      resolvePath(input: string) {
        return input;
      },
      on() {},
    });

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({
      name: "tinyfish_automation",
    });
  });
});
