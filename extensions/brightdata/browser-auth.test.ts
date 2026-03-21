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

function readAuthorizationHeader(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get("Authorization") ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === "authorization")?.[1];
  }
  return Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
}

describe("brightdata browser auth", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    withTrustedWebToolsEndpointMock.mockReset();
    vi.stubEnv("BRIGHTDATA_API_TOKEN", "test-token");
  });

  it("sends Bright Data bearer auth when resolving browser credentials", async () => {
    const { __testing: brightdataBrowserTesting } =
      await import("./src/brightdata-browser-tools.js");
    const { __testing: brightdataClientTesting } = await import("./src/brightdata-client.js");
    brightdataClientTesting.resetEnsuredBrightDataZones();

    withTrustedWebToolsEndpointMock.mockImplementation(
      async (
        params: { url: string; init?: RequestInit },
        run: (result: { response: Response; finalUrl: string }) => Promise<unknown>,
      ) => {
        expect(readAuthorizationHeader(params.init)).toBe("Bearer test-token");

        if (params.url.endsWith("/status")) {
          return await run({
            response: new Response(JSON.stringify({ customer: "customer-123" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        if (params.url.endsWith("/zone/get_active_zones")) {
          return await run({
            response: new Response(JSON.stringify([{ name: "mcp_browser" }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        if (params.url.endsWith("/zone/passwords?zone=mcp_browser")) {
          return await run({
            response: new Response(JSON.stringify({ passwords: ["secret-password"] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        throw new Error(`Unexpected URL in test mock: ${params.url}`);
      },
    );

    await expect(brightdataBrowserTesting.resolveBrightDataBrowserCdpEndpoint({})).resolves.toBe(
      "wss://brd-customer-customer-123-zone-mcp_browser:secret-password@brd.superproxy.io:9222",
    );
  });

  it("surfaces object-shaped Bright Data auth failures clearly", async () => {
    const { __testing: brightdataBrowserTesting } =
      await import("./src/brightdata-browser-tools.js");

    withTrustedWebToolsEndpointMock.mockImplementation(
      async (
        params: { url: string; init?: RequestInit },
        run: (result: { response: Response; finalUrl: string }) => Promise<unknown>,
      ) => {
        expect(readAuthorizationHeader(params.init)).toBe("Bearer test-token");

        if (params.url.endsWith("/status")) {
          return await run({
            response: new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        throw new Error(`Unexpected URL in test mock: ${params.url}`);
      },
    );

    await expect(brightdataBrowserTesting.resolveBrightDataBrowserCdpEndpoint({})).rejects.toThrow(
      'Bright Data status failed (401): {"message":"Unauthorized"}',
    );
  });
});
