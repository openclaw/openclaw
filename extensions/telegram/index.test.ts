import type { OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const hookMocks = vi.hoisted(() => ({
  setTelegramRuntime: vi.fn(),
  registerTelegramSubagentHooks: vi.fn(),
}));

vi.mock("./src/runtime.js", () => ({
  setTelegramRuntime: hookMocks.setTelegramRuntime,
}));

vi.mock("./src/subagent-hooks.js", () => ({
  registerTelegramSubagentHooks: hookMocks.registerTelegramSubagentHooks,
}));

describe("telegram plugin", () => {
  beforeEach(() => {
    hookMocks.setTelegramRuntime.mockClear();
    hookMocks.registerTelegramSubagentHooks.mockClear();
  });

  it("registers the telegram channel and subagent hooks", () => {
    const api = {
      runtime: { id: "runtime" },
      registerChannel: vi.fn(),
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(hookMocks.setTelegramRuntime).toHaveBeenCalledWith(api.runtime);
    expect(api.registerChannel).toHaveBeenCalledTimes(1);
    expect(hookMocks.registerTelegramSubagentHooks).toHaveBeenCalledWith(api);
  });
});
