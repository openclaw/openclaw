import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

describe("pkos-bridge plugin", () => {
  it("registers the initial bridge surfaces for task handoff, trace ingestion, and operator review", async () => {
    const registerTool = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerCommand = vi.fn();
    const registerHttpRoute = vi.fn();
    const on = vi.fn();

    const api = createTestPluginApi({
      id: "pkos-bridge",
      name: "pkos-bridge",
      source: "test",
      config: {},
      pluginConfig: {},
      registerTool,
      registerGatewayMethod,
      registerCommand,
      registerHttpRoute,
      on,
    });

    await plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(registerTool.mock.calls.map((call) => call[1]?.name)).toEqual([
      "pkos_bridge_status",
      "pkos_bridge_prepare_task_handoff",
      "pkos_bridge_submit_trace_bundle",
    ]);

    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "pkosBridge.status",
      "pkosBridge.prepareTaskHandoff",
      "pkosBridge.submitTraceBundle",
    ]);

    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0]?.[0]).toMatchObject({
      name: "pkos-bridge",
      acceptsArgs: true,
      requireAuth: true,
    });

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0]?.[0]).toMatchObject({
      path: "/plugins/pkos-bridge",
      auth: "plugin",
      match: "prefix",
    });

    expect(on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });
});
