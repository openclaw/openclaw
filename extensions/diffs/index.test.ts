import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("diffs plugin registration", () => {
  it("registers the tool, http handler, and prompt guidance hook", () => {
    const registerTool = vi.fn();
    const registerHttpHandler = vi.fn();
    const on = vi.fn();

    plugin.register?.({
      id: "diffs",
      name: "Diffs",
      description: "Diffs",
      source: "test",
      config: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool,
      registerHook() {},
      registerHttpHandler,
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      resolvePath(input: string) {
        return input;
      },
      on,
    });

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerHttpHandler).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("before_prompt_build");
  });
});
