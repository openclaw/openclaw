import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./core-api.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const { callBrowserRequest } = await import("./browser-cli-shared.js");

describe("callBrowserRequest", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayFromCli.mockClear();
  });

  it("requests the browser.request admin scope explicitly", async () => {
    await callBrowserRequest(
      { json: true },
      { method: "GET", path: "/status", query: { profile: "openclaw" } },
      { progress: true },
    );

    const extra = gatewayMocks.callGatewayFromCli.mock.calls[0]?.[3];
    expect(extra).toEqual({ progress: true, scopes: ["operator.admin"] });
  });
});
