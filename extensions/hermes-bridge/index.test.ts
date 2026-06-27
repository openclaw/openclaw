import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("hermes-bridge plugin entry", () => {
  it("registers a gateway-auth HTTP route and optional tool", () => {
    const routes: Array<{ path: string; auth: string; match?: string }> = [];
    const toolOptions: Array<{ name?: string; optional?: boolean }> = [];
    const api = createTestPluginApi({
      pluginConfig: {
        enabled: true,
        allowedTasks: ["status.echo"],
      },
      registerHttpRoute(route) {
        routes.push(route);
      },
      registerTool(_tool, opts) {
        toolOptions.push(opts ?? {});
      },
    });

    plugin.register(api);

    expect(routes).toMatchObject([
      {
        path: "/api/plugins/hermes-bridge/tasks",
        auth: "gateway",
        match: "exact",
      },
    ]);
    expect(toolOptions).toContainEqual({
      name: "hermes_bridge",
      optional: true,
    });
  });
});
