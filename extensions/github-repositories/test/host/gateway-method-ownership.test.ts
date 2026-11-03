import { expect, it } from "vitest";
import { GATEWAY_EVENTS } from "../../../../src/gateway/events.js";
import { listGatewayMethods } from "../../../../src/gateway/server-methods-list.js";
import { LEGACY_ADVERTISED_GATEWAY_METHODS } from "../../../../src/gateway/server-methods-list.test-fixtures.js";
import { coreGatewayHandlers } from "../../../../src/gateway/server-methods.js";
import { repositoryGatewayMethods } from "../../gateway-methods-api.js";

it("preserves the legacy advertised prefix and appends the MCP catalog", () => {
  const methods = listGatewayMethods();
  const pluginMethods = new Set<string>(repositoryGatewayMethods.map(([name]) => name));
  const retained = LEGACY_ADVERTISED_GATEWAY_METHODS.filter((name) => !pluginMethods.has(name));
  expect(methods.slice(0, retained.length)).toEqual(retained);
  expect(methods.indexOf("mcp.events.list")).toBeGreaterThanOrEqual(retained.length);
});

it("leaves repository discovery to its installed plugin and retains the shared event", () => {
  const methods = listGatewayMethods();
  for (const [name] of repositoryGatewayMethods) {
    expect(methods).not.toContain(name);
    expect(coreGatewayHandlers).not.toHaveProperty(name);
  }
  expect(GATEWAY_EVENTS).toContain("controlUi.sessionPullRequests.changed");
});
