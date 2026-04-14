import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import plugin from "./index.js";

describe("sense worker plugin registration", () => {
  it("registers commands and optional non-sandbox tools", () => {
    const registerCommand = vi.fn();
    const registerTool = vi.fn();
    plugin.register?.(
      createTestPluginApi({
        id: "sense-worker",
        name: "Sense Worker",
        description: "Sense Worker",
        source: "test",
        config: {},
        runtime: {} as never,
        registerCommand,
        registerTool,
      }),
    );

    expect(registerCommand).toHaveBeenCalledTimes(2);
    expect(registerCommand.mock.calls.map(([entry]) => entry?.name)).toEqual(["nemoclaw", "run"]);
    expect(registerTool).toHaveBeenCalledTimes(2);
    const [factory, options] = registerTool.mock.calls[0] ?? [];
    expect(options).toMatchObject({ optional: true });
    expect(factory({ sandboxed: true })).toBeNull();
    expect(factory({ sandboxed: false })).toMatchObject({ name: "sense-worker" });
  });
});
