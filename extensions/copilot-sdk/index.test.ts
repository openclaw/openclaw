import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("copilot-sdk plugin", () => {
  it("registers the copilot-sdk agent harness", () => {
    const registerAgentHarness = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "copilot-sdk",
        name: "GitHub Copilot SDK",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
      }),
    );

    expect(registerAgentHarness).toHaveBeenCalledTimes(1);
    expect(registerAgentHarness).toHaveBeenCalledWith(
      expect.objectContaining({ id: "copilot-sdk", label: "GitHub Copilot SDK" }),
    );
  });
});
