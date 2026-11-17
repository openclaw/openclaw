// The registered /a2a/v1 handler claims browser Accept values itself.
// A text/html or wildcard client must still get the plugin JSON 404, which is
// what keeps those requests off the Control UI document.
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";

const JSON_NOT_FOUND = JSON.stringify({ error: "Not found" });

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it.each([
  { accept: undefined, label: "absent" },
  { accept: "*/*", label: "*/*" },
  { accept: "text/html", label: "text/html" },
])("claims GET /a2a/v1/agent-card as JSON 404 when Accept is $label", async ({ accept }) => {
  const fixture = createA2aGatewayFixture();
  const lifecycle = a2aChannelPlugin.gateway!.startAccount!(fixture.ctx);
  try {
    await vi.waitFor(() => expect(fixture.ctx.getStatus().lifecycle).toBe("ready"));
    const handler = fixture.registry.httpRoutes.find((route) => route.path === "/a2a/v1")?.handler;
    if (!handler) {
      throw new Error("A2A did not register /a2a/v1");
    }

    const request = createMockIncomingRequest([]);
    request.method = "GET";
    request.url = "/a2a/v1/agent-card";
    request.headers = {
      host: "gateway.example.test",
      ...(accept === undefined ? {} : { accept }),
    };
    const response = createMockServerResponse();
    await expect(handler(request, response)).resolves.toBe(true);
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(JSON_NOT_FOUND);
    expect(response.getHeader("content-type")).toBe("application/json; charset=utf-8");
  } finally {
    fixture.controller.abort();
    await lifecycle;
  }
});
