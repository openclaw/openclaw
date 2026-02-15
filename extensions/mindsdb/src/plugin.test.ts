import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

describe("mindsdb plugin", () => {
  it("registers the mindsdb tool as optional", () => {
    const registerTool = vi.fn();

    plugin.register({
      id: "mindsdb",
      name: "MindsDB",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      registerTool,
      registerHook() {},
      registerHttpHandler() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      resolvePath: (input: string) => input,
      on() {},
    } as never);

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mindsdb" }),
      expect.objectContaining({ optional: true }),
    );
  });
});
