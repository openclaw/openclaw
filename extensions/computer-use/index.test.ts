import { describe, expect, it, vi } from "vitest";
import register from "./index.js";

describe("computer-use plugin registration", () => {
  it("registers the computer-use tool as optional", () => {
    const registerTool = vi.fn();

    register({
      id: "computer-use",
      name: "Computer Use",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      logger: {
        debug() {},
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
    } as never);

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({
      name: "computer-use",
      label: "Computer Use",
    });
    expect(registerTool.mock.calls[0]?.[1]).toEqual({ optional: true });
  });
});
