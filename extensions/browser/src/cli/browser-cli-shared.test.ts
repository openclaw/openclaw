import { afterEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({ ok: true, via: "gateway" })),
}));

vi.mock("./core-api.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

import { callBrowserRequest } from "./browser-cli-shared.js";

describe("browser cli local-browser-bridge adapter", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("routes profile=user status through local-browser-bridge before gateway", async () => {
    vi.stubEnv("OPENCLAW_LOCAL_BROWSER_BRIDGE_URL", "http://127.0.0.1:3000");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capabilities: { navigate: true } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            diagnostics: {
              browser: "safari",
              attach: { mode: "direct" },
              ready: true,
              blockers: [],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callBrowserRequest(
      { browserProfile: "user" },
      {
        method: "GET",
        path: "/",
      },
      { timeoutMs: 1234 },
    );

    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      adapter: "local-browser-bridge",
      profile: "user",
      route: "safari-direct",
      running: true,
      chosenBrowser: "safari",
    });
  });

  it("falls back to the gateway for unsupported bridge-backed request paths", async () => {
    vi.stubEnv("OPENCLAW_LOCAL_BROWSER_BRIDGE_URL", "http://127.0.0.1:3000");

    const result = await callBrowserRequest(
      { browserProfile: "user" },
      {
        method: "POST",
        path: "/act",
        body: { kind: "click" },
      },
      { timeoutMs: 1234 },
    );

    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, via: "gateway" });
  });

  it("rejects write actions for profile=chrome-relay", async () => {
    vi.stubEnv("OPENCLAW_LOCAL_BROWSER_BRIDGE_URL", "http://127.0.0.1:3000");

    await expect(
      callBrowserRequest(
        { browserProfile: "chrome-relay" },
        {
          method: "POST",
          path: "/navigate",
          body: { url: "https://example.com" },
        },
        { timeoutMs: 1234 },
      ),
    ).rejects.toThrow("read-only in v1");
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });
});
