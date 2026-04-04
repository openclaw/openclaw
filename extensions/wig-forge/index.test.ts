import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../test-utils/plugin-api.js";
import plugin from "./index.js";

describe("wig-forge plugin registration", () => {
  it("registers tools and prompt guidance", async () => {
    const registerTool = vi.fn();
    const registerHttpRoute = vi.fn();
    const on = vi.fn();

    plugin.register?.(
      createTestPluginApi({
        id: "wig-forge",
        name: "Wig Forge",
        description: "Wig Forge",
        source: "test",
        config: {},
        runtime: {} as never,
        registerTool,
        registerHttpRoute,
        on,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0]?.[0]).toMatchObject({
      path: "/plugins/wig-forge",
      auth: "plugin",
      match: "prefix",
    });
    expect(on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const result = await on.mock.calls[0]?.[1]?.({}, {});
    expect(result).toMatchObject({
      prependSystemContext: expect.stringContaining("Wig Forge"),
    });
  });
});
