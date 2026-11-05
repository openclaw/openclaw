import type { ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { GeolocationDatabase } from "./database-store.js";

const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn<() => Promise<void>>() }));
const { loadDatabase } = vi.hoisted(() => ({
  loadDatabase: vi.fn<() => Promise<GeolocationDatabase>>(),
}));
const warn = vi.fn();
const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
vi.mock("./database-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./database-store.js")>()),
  createGeolocationDatabaseStore: () => ({ load: loadDatabase }),
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({ revalidate }),
}));

beforeEach(() => {
  revalidate.mockReset();
  loadDatabase.mockReset();
  warn.mockClear();
  response.writeHead.mockClear();
  response.end.mockClear();
});

async function lookup(ip = "8.8.8.8") {
  const registerHttpRoute = vi.fn<OpenClawPluginApi["registerHttpRoute"]>();
  const api = createTestPluginApi({ registerHttpRoute });
  plugin.register({
    ...api,
    logger: { ...api.logger, warn },
  });
  const handler = registerHttpRoute.mock.calls[0]?.[0].handler;
  if (!handler) {
    throw new Error("Geolocation HTTP route was not registered");
  }
  await handler(
    { url: `/plugins/geolocation/lookup?ip=${ip}` } as never,
    response as unknown as ServerResponse,
  );
  return {
    status: response.writeHead.mock.lastCall?.[0],
    body: JSON.parse(response.end.mock.lastCall?.[0]),
  };
}

describe("geolocation lookup route", () => {
  it("withholds results if HTTP authority expires during the database load", async () => {
    const expired = new Error("HTTP grant revoked");
    let current = true;
    revalidate.mockImplementation(async () => {
      if (!current) {
        throw expired;
      }
    });
    loadDatabase.mockImplementation(async () => {
      current = false;
      return { lookup: () => null };
    });
    await expect(lookup()).rejects.toBe(expired);
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });

  it("answers with the placement and the credit its license requires", async () => {
    loadDatabase.mockResolvedValue({
      lookup: () => ({
        city: { geoname_id: 2761369, names: { en: "Vienna" } },
        subdivisions: [{ geoname_id: 2761367, iso_code: "9", names: { en: "Vienna" } }],
        country: { geoname_id: 2782113, iso_code: "AT", names: { en: "Austria" } },
      }),
    });
    const out = await lookup();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      found: true,
      city: "Vienna",
      country: "Austria",
      countryCode: "AT",
      attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
    });
  });

  it("reports a database outage as an outage, never as a located-nowhere answer", async () => {
    loadDatabase.mockRejectedValue(new Error("download failed"));
    const out = await lookup();

    expect(out.status).toBe(503);
    expect(out.body).not.toHaveProperty("found");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("distinguishes an address the database does not place from an outage", async () => {
    loadDatabase.mockResolvedValue({ lookup: () => null });
    const out = await lookup();

    expect(out.status).toBe(200);
    expect(out.body.found).toBe(false);
  });

  it("rejects a non-address instead of handing it to the database", async () => {
    const databaseLookup = vi.fn();
    loadDatabase.mockResolvedValue({ lookup: databaseLookup });
    const out = await lookup("not-an-ip");

    expect(out.status).toBe(400);
    expect(databaseLookup).not.toHaveBeenCalled();
  });

  it("answers unresolvable ranges without consulting the database", async () => {
    for (const ip of ["100.64.1.5", "192.168.1.20", "10.0.0.4", "127.0.0.1", "169.254.1.1"]) {
      const out = await lookup(ip);
      expect(out.status, ip).toBe(200);
      expect(out.body.found, ip).toBe(false);
    }

    expect(loadDatabase).not.toHaveBeenCalled();
  });
});
