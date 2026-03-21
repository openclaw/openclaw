import { beforeEach, describe, expect, it, vi } from "vitest";

const { withTrustedWebToolsEndpointMock } = vi.hoisted(() => ({
  withTrustedWebToolsEndpointMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-web-search", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-web-search")>(
    "openclaw/plugin-sdk/provider-web-search",
  );
  return {
    ...actual,
    withTrustedWebToolsEndpoint: withTrustedWebToolsEndpointMock,
  };
});

describe("brightdata browser zone bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    withTrustedWebToolsEndpointMock.mockReset();
    vi.stubEnv("BRIGHTDATA_API_TOKEN", "test-token");
  });

  it("ensures the browser zone once before browser usage", async () => {
    const { __testing, ensureBrightDataBrowserZoneExists } =
      await import("./src/brightdata-client.js");
    __testing.resetEnsuredBrightDataZones();

    withTrustedWebToolsEndpointMock.mockImplementation(
      async (
        params: { url: string; init?: RequestInit },
        run: (result: { response: Response; finalUrl: string }) => Promise<unknown>,
      ) => {
        if (params.url.endsWith("/zone/get_active_zones")) {
          return await run({
            response: new Response(JSON.stringify([]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        if (params.url.endsWith("/zone")) {
          expect(JSON.parse(String(params.init?.body ?? ""))).toEqual({
            zone: { name: "mcp_browser", type: "browser_api" },
            plan: { type: "browser_api" },
          });
          return await run({
            response: new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        throw new Error(`Unexpected URL in test mock: ${params.url}`);
      },
    );

    const [first, second] = await Promise.all([
      ensureBrightDataBrowserZoneExists(),
      ensureBrightDataBrowserZoneExists(),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(
      withTrustedWebToolsEndpointMock.mock.calls.filter((call) =>
        String(call[0]?.url).endsWith("/zone/get_active_zones"),
      ),
    ).toHaveLength(1);
    expect(
      withTrustedWebToolsEndpointMock.mock.calls.filter((call) =>
        String(call[0]?.url).endsWith("/zone"),
      ),
    ).toHaveLength(1);
  });
});
