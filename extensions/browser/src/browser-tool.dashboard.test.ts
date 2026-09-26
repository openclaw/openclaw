import "./browser-tool.test-support.js";
import { describe, expect, it } from "vitest";
import { createBrowserTool } from "./browser-tool.js";

const { browserClientMocks, gatewayMocks, registerBrowserToolAfterEachReset } =
  await import("./browser-tool.test-support.js");

describe("scoped dashboard Gateway admission", () => {
  registerBrowserToolAfterEachReset();

  it.each([{ scopes: ["operator.write"] }, { scopes: ["operator.sessions.write"] }])(
    "uses isolated admission for a scoped operator $scopes",
    async ({ scopes }) => {
      gatewayMocks.readGatewayToolOperatorScopes.mockReturnValue(scopes);
      const dashboard = {
        sessionKey: "agent:main:dashboard-test",
        name: "service",
        instanceId: "widget-one",
        revision: 1,
        paused: false,
        stopping: false,
        url: "https://example.test/",
        browserTab: { target: "host", profile: "openclaw", targetId: "ISOLATED" },
      };
      gatewayMocks.callGatewayTool.mockResolvedValueOnce(dashboard).mockResolvedValueOnce({
        running: true,
        tabs: [{ targetId: "ISOLATED", title: "Review", url: "https://example.test/" }],
      });
      const tool = createBrowserTool({ agentSessionKey: dashboard.sessionKey, agentId: "main" });
      await tool.execute("scoped-dashboard", { action: "tabs", dashboard: "service" });
      expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
        1,
        "browser.dashboard.request",
        expect.anything(),
        expect.objectContaining({
          sessionKey: dashboard.sessionKey,
          agentId: "main",
          path: "/dashboard",
        }),
        expect.objectContaining({ scopes }),
      );
      expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
        2,
        "browser.dashboard.request",
        expect.anything(),
        expect.objectContaining({
          sessionKey: dashboard.sessionKey,
          path: "/tabs",
          dashboard: { name: "service", instanceId: "widget-one" },
          query: undefined,
        }),
        expect.objectContaining({ scopes }),
      );
      expect(browserClientMocks.browserTabs).not.toHaveBeenCalled();
    },
  );
});
