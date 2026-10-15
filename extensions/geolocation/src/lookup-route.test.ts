import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGeolocationSettings } from "./config.js";
import { createGeolocationLookupHandler } from "./lookup-route.js";
import { createGeolocationLookup } from "./lookup.js";

const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn<() => Promise<void>>() }));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({ revalidate }),
}));

beforeEach(() => {
  revalidate.mockReset();
});

const settings = resolveGeolocationSettings(undefined);

async function lookup(
  deps: Omit<Parameters<typeof createGeolocationLookup>[0], "settings">,
  ip = "8.8.8.8",
) {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (body?: string) => {
      if (body) {
        chunks.push(body);
      }
    },
  };
  await createGeolocationLookupHandler(createGeolocationLookup({ settings, ...deps }))(
    { url: `/plugins/geolocation/lookup?ip=${ip}` } as never,
    res as unknown as ServerResponse,
  );
  return { status, body: chunks.length > 0 ? JSON.parse(chunks.join("")) : undefined };
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
    const handler = createGeolocationLookupHandler(
      createGeolocationLookup({
        settings,
        loadDatabase: async () => {
          current = false;
          return { lookup: () => null };
        },
      }),
    );
    const respond = vi.fn();
    const response = { writeHead: respond, end: respond };
    respond.mockReturnValue(response);
    await expect(
      handler(
        { url: "/plugins/geolocation/lookup?ip=8.8.8.8" } as never,
        response as unknown as ServerResponse,
      ),
    ).rejects.toBe(expired);
    expect(respond).not.toHaveBeenCalled();
  });

  it("answers with the placement and the credit its license requires", async () => {
    const out = await lookup({
      loadDatabase: async () => ({
        lookup: () => ({
          city: { geoname_id: 2761369, names: { en: "Vienna" } },
          subdivisions: [{ geoname_id: 2761367, iso_code: "9", names: { en: "Vienna" } }],
          country: { geoname_id: 2782113, iso_code: "AT", names: { en: "Austria" } },
        }),
      }),
    });

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
    const warn = vi.fn();
    const out = await lookup({
      logger: { warn },
      loadDatabase: async () => {
        throw new Error("download failed");
      },
    });

    expect(out.status).toBe(503);
    expect(out.body).not.toHaveProperty("found");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("distinguishes an address the database does not place from an outage", async () => {
    const out = await lookup({
      loadDatabase: async () => ({ lookup: () => null }),
    });

    expect(out.status).toBe(200);
    expect(out.body.found).toBe(false);
  });

  it("rejects a non-address instead of handing it to the database", async () => {
    const databaseLookup = vi.fn();
    const out = await lookup(
      { loadDatabase: async () => ({ lookup: databaseLookup }) },
      "not-an-ip",
    );

    expect(out.status).toBe(400);
    expect(databaseLookup).not.toHaveBeenCalled();
  });

  it("answers unresolvable ranges without consulting the database", async () => {
    const loadDatabase = vi.fn();

    for (const ip of ["100.64.1.5", "192.168.1.20", "10.0.0.4", "127.0.0.1", "169.254.1.1"]) {
      const out = await lookup({ loadDatabase }, ip);
      expect(out.status, ip).toBe(200);
      expect(out.body.found, ip).toBe(false);
    }

    expect(loadDatabase).not.toHaveBeenCalled();
  });
});
