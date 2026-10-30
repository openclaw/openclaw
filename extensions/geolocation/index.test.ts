import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { GeolocationDatabase } from "./src/database-store.js";

const loadDatabase = vi.hoisted(() => vi.fn<() => Promise<GeolocationDatabase>>());
vi.mock("./src/database-store.js", () => ({
  createGeolocationDatabaseStore: () => ({ load: loadDatabase }),
}));

const respond = vi.fn();
const method = "geolocation.lookup";

function lookup(params: Record<string, unknown>, hasCurrentClientAuthority = () => true) {
  const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
  plugin.register(createTestPluginApi({ registerGatewayMethod }));
  return registerGatewayMethod.mock.calls.find(([name]) => name === method)![1]({
    req: { type: "req", id: "lookup", method },
    params,
    respond,
    client: null,
    context: {} as GatewayRequestHandlerOptions["context"],
    isWebchatConnect: () => false,
    hasCurrentClientAuthority,
  });
}

beforeEach(() => vi.resetAllMocks());

it("returns one coarse answer per IP with database attribution", async () => {
  const place = { city: "Mountain View", country: "United States", countryCode: "US" };
  const record = {
    city: { geoname_id: 1, names: { en: place.city } },
    country: { geoname_id: 2, iso_code: place.countryCode, names: { en: place.country } },
  };
  loadDatabase.mockResolvedValue({ lookup: (ip) => (ip === "8.8.8.8" ? record : null) });
  await lookup({ ips: ["8.8.8.8", "203.0.113.1", "8.8.8.8"] });
  const attribution = { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" };
  expect(respond).toHaveBeenCalledWith(true, {
    results: [
      { ip: "8.8.8.8", status: "found", ...place, attribution },
      { ip: "203.0.113.1", status: "not-found", attribution },
    ],
  });
  expect(loadDatabase).toHaveBeenCalledOnce();
});

it("distinguishes a database outage from addresses which cannot be located", async () => {
  loadDatabase.mockRejectedValue(new Error("database unavailable"));
  await lookup({ ips: ["8.8.8.8", "192.168.0.1"] });

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
  await lookup(params);

  const error = expect.objectContaining({ code: "INVALID_REQUEST" });
  expect(respond.mock.calls).toEqual([[false, undefined, error]]);
  expect(loadDatabase).not.toHaveBeenCalled();
});

it("withholds a pending result after the caller loses its authority", async () => {
  let current = true;
  loadDatabase.mockImplementation(async () => {
    current = false;
    return { lookup: () => null };
  });
  await expect(lookup({ ips: ["8.8.8.8"] }, () => current)).rejects.toThrow(
    "Gateway requester authority changed",
  );
  expect(respond).not.toHaveBeenCalled();
});
