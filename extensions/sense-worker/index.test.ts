import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import plugin from "./index.js";

describe("sense worker plugin registration", () => {
  it("registers an optional non-sandbox tool", () => {
    const registerTool = vi.fn();
    plugin.register?.(
      createTestPluginApi({
        id: "sense-worker",
        name: "Sense Worker",
        description: "Sense Worker",
        source: "test",
        config: {},
        runtime: {} as never,
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [factory, options] = registerTool.mock.calls[0] ?? [];
    expect(options).toMatchObject({ optional: true });
    expect(factory({ sandboxed: true })).toBeNull();
    expect(factory({ sandboxed: false })).toMatchObject({ name: "sense-worker" });
  });
});
