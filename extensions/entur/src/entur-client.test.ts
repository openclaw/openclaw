import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { resolveEnturConfig } from "./config.js";

const { searchStops, getDepartures, getNearbyStops } = vi.hoisted(() => ({
  searchStops: vi.fn(),
  getDepartures: vi.fn(),
  getNearbyStops: vi.fn(),
}));

vi.mock("./entur-client.js", () => ({
  searchStops,
  getDepartures,
  getNearbyStops,
  __testing: {},
}));

function fakeApi(config?: Record<string, unknown>): OpenClawPluginApi {
  return {
    config: config ?? {},
  } as OpenClawPluginApi;
}

describe("entur plugin", () => {
  let createSearchStopsTool: typeof import("./search-stops-tool.js").createSearchStopsTool;
  let createGetDeparturesTool: typeof import("./get-departures-tool.js").createGetDeparturesTool;
  let createGetNearbyStopsTool: typeof import("./get-nearby-stops-tool.js").createGetNearbyStopsTool;

  beforeAll(async () => {
    vi.resetModules();
    ({ createSearchStopsTool } = await import("./search-stops-tool.js"));
    ({ createGetDeparturesTool } = await import("./get-departures-tool.js"));
    ({ createGetNearbyStopsTool } = await import("./get-nearby-stops-tool.js"));
  });

  beforeEach(() => {
    searchStops.mockReset();
    getDepartures.mockReset();
    getNearbyStops.mockReset();
  });

  it("registers three tools", () => {
    const registrations: unknown[] = [];
    const mockApi = {
      registerTool(tool: unknown) {
        registrations.push(tool);
      },
      config: {},
    };

    plugin.register(mockApi as unknown as OpenClawPluginApi);

    expect(registrations).toHaveLength(3);
    const names = registrations.map((t) => (t as { name: string }).name);
    expect(names).toContain("entur_search_stops");
    expect(names).toContain("entur_get_departures");
    expect(names).toContain("entur_get_nearby_stops");
  });

  describe("config resolution", () => {
    it("returns defaults when no config is set", () => {
      const config = resolveEnturConfig({} as never);
      expect(config.clientName).toBe("openclaw-entur");
      expect(config.defaultStopId).toBeUndefined();
      expect(config.defaultNumDepartures).toBe(10);
      expect(config.defaultTransportModes).toBeUndefined();
    });

    it("reads plugin config", () => {
      const config = resolveEnturConfig({
        plugins: {
          entries: {
            entur: {
              config: {
                clientName: "my-app",
                defaultStopId: "NSR:StopPlace:123",
                defaultNumDepartures: 5,
                defaultTransportModes: ["tram"],
              },
            },
          },
        },
      } as never);
      expect(config.clientName).toBe("my-app");
      expect(config.defaultStopId).toBe("NSR:StopPlace:123");
      expect(config.defaultNumDepartures).toBe(5);
      expect(config.defaultTransportModes).toEqual(["tram"]);
    });
  });

  describe("entur_search_stops", () => {
    it("passes query and max_results to searchStops", async () => {
      const mockStops = [
        {
          id: "NSR:StopPlace:58366",
          name: "Jernbanetorget",
          locality: "Oslo",
          county: "Oslo",
          latitude: 59.91,
          longitude: 10.75,
          transportModes: ["metro", "tram", "bus"],
        },
      ];
      searchStops.mockResolvedValue(mockStops);

      const tool = createSearchStopsTool(fakeApi());
      const result = await tool.execute("call-1", { query: "Jernbanetorget", max_results: 3 });

      expect(searchStops).toHaveBeenCalledWith("Jernbanetorget", 3, "openclaw-entur");
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toContain("Jernbanetorget");
    });

    it("defaults max_results to 5", async () => {
      searchStops.mockResolvedValue([]);

      const tool = createSearchStopsTool(fakeApi());
      await tool.execute("call-2", { query: "Majorstuen" });

      expect(searchStops).toHaveBeenCalledWith("Majorstuen", 5, "openclaw-entur");
    });
  });

  describe("entur_get_departures", () => {
    it("passes parameters to getDepartures", async () => {
      const mockResult = {
        stop: { id: "NSR:StopPlace:58366", name: "Jernbanetorget" },
        departures: [
          {
            line: "17",
            destination: "Rikshospitalet",
            transportMode: "tram",
            scheduledTime: "2026-04-12T10:00:00+02:00",
            expectedTime: "2026-04-12T10:02:00+02:00",
            minutesUntil: 5,
            realtime: true,
            cancelled: false,
            platform: "1",
          },
        ],
      };
      getDepartures.mockResolvedValue(mockResult);

      const tool = createGetDeparturesTool(fakeApi());
      const result = await tool.execute("call-3", {
        stop_id: "NSR:StopPlace:58366",
        num_departures: 5,
        transport_modes: ["tram"],
        time_range_minutes: 60,
      });

      expect(getDepartures).toHaveBeenCalledWith(
        "NSR:StopPlace:58366",
        5,
        ["tram"],
        60,
        "openclaw-entur",
      );
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toContain("Rikshospitalet");
    });

    it("uses default stop ID from config when stop_id is omitted", async () => {
      getDepartures.mockResolvedValue({
        stop: { id: "NSR:StopPlace:123", name: "Home" },
        departures: [],
      });

      const api = fakeApi({
        plugins: {
          entries: {
            entur: {
              config: {
                defaultStopId: "NSR:StopPlace:123",
              },
            },
          },
        },
      });
      const tool = createGetDeparturesTool(api);
      await tool.execute("call-4", {});

      expect(getDepartures).toHaveBeenCalledWith(
        "NSR:StopPlace:123",
        10,
        undefined,
        120,
        "openclaw-entur",
      );
    });

    it("throws when no stop_id and no default configured", async () => {
      const tool = createGetDeparturesTool(fakeApi());
      await expect(tool.execute("call-5", {})).rejects.toThrow("No stop_id provided");
    });
  });

  describe("entur_get_nearby_stops", () => {
    it("passes coordinates and options to getNearbyStops", async () => {
      getNearbyStops.mockResolvedValue([]);

      const tool = createGetNearbyStopsTool(fakeApi());
      await tool.execute("call-6", {
        latitude: 59.91,
        longitude: 10.75,
        radius_meters: 300,
        max_results: 3,
      });

      expect(getNearbyStops).toHaveBeenCalledWith(59.91, 10.75, 300, 3, "openclaw-entur");
    });

    it("uses default radius and max_results", async () => {
      getNearbyStops.mockResolvedValue([]);

      const tool = createGetNearbyStopsTool(fakeApi());
      await tool.execute("call-7", { latitude: 59.91, longitude: 10.75 });

      expect(getNearbyStops).toHaveBeenCalledWith(59.91, 10.75, 500, 5, "openclaw-entur");
    });
  });
});
