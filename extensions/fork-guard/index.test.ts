import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import entry, { registerForkGuardPlugin } from "./index.js";

describe("fork-guard plugin registration", () => {
  it("registers a before_tool_call hook scoped to exec", () => {
    const on = vi.fn();
    const api = createTestPluginApi({
      id: "fork-guard",
      name: "Fork Guard",
      source: "test",
      config: {},
      runtime: {} as never,
      pluginConfig: {},
      on,
    });

    registerForkGuardPlugin(api);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith(
      "before_tool_call",
      expect.any(Function),
      expect.objectContaining({ toolNames: ["exec"] }),
    );
  });

  it("exports the expected plugin metadata", () => {
    expect(entry.id).toBe("fork-guard");
    expect(entry.name).toBe("Fork Guard");
    expect(entry.register).toEqual(expect.any(Function));
  });
});
