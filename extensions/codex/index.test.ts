import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

describe("codex plugin", () => {
  it("registers the codex provider and agent harness", () => {
    const registerAgentHarness = vi.fn();
    const registerProvider = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
        registerProvider,
      }),
    );

    expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({ id: "codex", label: "Codex" });
    expect(registerAgentHarness.mock.calls[0]?.[0]).toMatchObject({
      id: "codex",
      label: "Codex agent harness",
    });
  });
});
