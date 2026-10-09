import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeolocationDatabase } from "./src/database-store.js";

const { loadDatabase } = vi.hoisted(() => ({
  loadDatabase: vi.fn<() => Promise<GeolocationDatabase>>(),
}));
vi.mock("./src/database-store.js", () => ({
  createGeolocationDatabaseStore: () => ({ load: loadDatabase }),
}));

import plugin from "./index.js";

function captureLookup() {
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  capturePluginRegistration({
    id: plugin.id,
    name: plugin.name,
    register(api) {
      plugin.register({
        ...api,
        registerGatewayMethod(name, handler) {
          methods.set(name, handler);
        },
        registerHttpRoute() {},
      });
    },
  });
  const handler = methods.get("geolocation.lookup");
  if (!handler) {
    throw new Error("geolocation.lookup was not registered");
  }
  return (
    params: Record<string, unknown>,
    overrides: Partial<GatewayRequestHandlerOptions> = {},
  ) => {
    const respond = vi.fn();
    const pending = handler({
      req: { type: "req", id: "lookup", method: "geolocation.lookup" },
      params,
      respond,
      client: null,
      context: {} as GatewayRequestHandlerOptions["context"],
      isWebchatConnect: () => false,
      ...overrides,
    });
    return { pending, respond };
  };
}

beforeEach(() => {
  loadDatabase.mockReset();
});

describe("geolocation Gateway lookup", () => {
  it("returns one coarse answer per IP with database attribution", async () => {
    loadDatabase.mockResolvedValue({
      lookup: (ip) =>
        ip === "8.8.8.8"
          ? {
              city: { geoname_id: 1, names: { en: "Mountain View" } },
              country: { geoname_id: 2, iso_code: "US", names: { en: "United States" } },
            }
          : null,
    });
    const { pending, respond } = captureLookup()({
      ips: ["8.8.8.8", "100.64.0.1", "203.0.113.1", "8.8.8.8"],
    });
    await pending;

    const attribution = { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" };
    expect(respond).toHaveBeenCalledWith(true, {
      results: [
        {
          ip: "8.8.8.8",
          status: "found",
          city: "Mountain View",
          country: "United States",
          countryCode: "US",
          attribution,
        },
        { ip: "100.64.0.1", status: "not-found", attribution },
        { ip: "203.0.113.1", status: "not-found", attribution },
      ],
    });
    expect(loadDatabase).toHaveBeenCalledOnce();
  });

  it("distinguishes a database outage from addresses which cannot be located", async () => {
    loadDatabase.mockRejectedValue(new Error("database unavailable"));
    const { pending, respond } = captureLookup()({ ips: ["8.8.8.8", "192.168.0.1"] });
    await pending;

    expect(respond).toHaveBeenCalledWith(true, {
      results: [
        expect.objectContaining({ ip: "8.8.8.8", status: "unavailable" }),
        expect.objectContaining({ ip: "192.168.0.1", status: "not-found" }),
      ],
    });
  });

  it.each([
    { name: "missing addresses", params: {} },
    { name: "invalid address", params: { ips: ["not-an-address"] } },
    { name: "oversized batch", params: { ips: Array.from({ length: 201 }, () => "8.8.8.8") } },
    { name: "unknown parameter", params: { ips: ["8.8.8.8"], other: true } },
  ])("rejects $name without loading the database", async ({ params }) => {
    const { pending, respond } = captureLookup()(params);
    await pending;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("withholds a pending result after the caller loses its authority", async () => {
    let current = true;
    loadDatabase.mockImplementation(async () => {
      current = false;
      return { lookup: () => null };
    });
    const { pending, respond } = captureLookup()(
      { ips: ["8.8.8.8"] },
      { hasCurrentClientAuthority: () => current },
    );

    await expect(pending).rejects.toThrow("Gateway requester authority changed");
    expect(respond).not.toHaveBeenCalled();
  });
});
