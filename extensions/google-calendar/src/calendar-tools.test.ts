import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { createCalendarTools } from "./calendar-tools.js";

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    id: "google-calendar",
    name: "google-calendar",
    source: "test",
    config: {},
    pluginConfig: { accessToken: "test-token-123", calendarId: "primary" },
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  } as unknown as OpenClawPluginApi;
}

function findTool(tools: ReturnType<typeof createCalendarTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

describe("calendar tools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates four tools", () => {
    const tools = createCalendarTools(fakeApi());
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "calendar_list_events",
      "calendar_search_events",
      "calendar_create_event",
      "calendar_get_event",
    ]);
  });

  describe("calendar_list_events", () => {
    it("returns formatted events", async () => {
      const mockData = {
        items: [
          {
            id: "ev1",
            summary: "Team standup",
            start: { dateTime: "2024-03-15T09:00:00-07:00" },
            end: { dateTime: "2024-03-15T09:30:00-07:00" },
            location: "Room A",
            htmlLink: "https://calendar.google.com/event/ev1",
          },
        ],
      };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_list_events");
      const result = await tool.execute("call1", {});

      expect(result.content[0].text).toContain("Team standup");
      expect(result.content[0].text).toContain("Room A");
      expect(result.content[0].text).toContain("2024-03-15T09:00:00");
    });

    it("defaults timeMin to roughly now", async () => {
      const mockData = { items: [] };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const before = new Date().toISOString();
      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_list_events");
      await tool.execute("call2", {});

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      const url = new URL(calledUrl);
      const timeMin = url.searchParams.get("timeMin")!;
      // timeMin should be close to now (within a few seconds)
      expect(new Date(timeMin).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime() - 5000);
    });

    it("respects maxResults parameter", async () => {
      const mockData = { items: [] };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_list_events");
      await tool.execute("call3", { maxResults: 5 });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get("maxResults")).toBe("5");
    });

    it("returns no-events message when empty", async () => {
      const mockData = { items: [] };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_list_events");
      const result = await tool.execute("call4", {});

      expect(result.content[0].text).toContain("No upcoming events");
    });
  });

  describe("calendar_search_events", () => {
    it("passes query parameter to API", async () => {
      const mockData = {
        items: [
          {
            id: "ev2",
            summary: "Dentist appointment",
            start: { dateTime: "2024-03-20T14:00:00-07:00" },
            end: { dateTime: "2024-03-20T15:00:00-07:00" },
          },
        ],
      };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_search_events");
      const result = await tool.execute("call5", { query: "dentist" });

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get("q")).toBe("dentist");
      expect(result.content[0].text).toContain("Dentist appointment");
    });

    it("returns no-results message", async () => {
      const mockData = { items: [] };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_search_events");
      const result = await tool.execute("call6", { query: "nonexistent" });

      expect(result.content[0].text).toContain("No events found");
    });
  });

  describe("calendar_create_event", () => {
    it("sends correct POST body and returns created event", async () => {
      const createdEvent = {
        id: "ev3",
        summary: "Lunch",
        start: { dateTime: "2024-03-15T12:00:00-07:00" },
        end: { dateTime: "2024-03-15T13:00:00-07:00" },
        htmlLink: "https://calendar.google.com/event/ev3",
      };
      const fetchMock = mockFetchResponse(createdEvent);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_create_event");
      const result = await tool.execute("call7", {
        summary: "Lunch",
        startTime: "2024-03-15T12:00:00-07:00",
        endTime: "2024-03-15T13:00:00-07:00",
        location: "Café",
      });

      // Verify POST was sent
      const callOpts = fetchMock.mock.calls[0][1];
      expect(callOpts.method).toBe("POST");
      const body = JSON.parse(callOpts.body);
      expect(body.summary).toBe("Lunch");
      expect(body.location).toBe("Café");

      expect(result.content[0].text).toContain("Created event: Lunch");
    });

    it("includes attendees when provided", async () => {
      const createdEvent = {
        id: "ev4",
        summary: "Meeting",
        start: { dateTime: "2024-03-15T10:00:00-07:00" },
        end: { dateTime: "2024-03-15T11:00:00-07:00" },
      };
      const fetchMock = mockFetchResponse(createdEvent);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_create_event");
      await tool.execute("call8", {
        summary: "Meeting",
        startTime: "2024-03-15T10:00:00-07:00",
        endTime: "2024-03-15T11:00:00-07:00",
        attendees: ["alice@example.com", "bob@example.com"],
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attendees).toEqual([
        { email: "alice@example.com" },
        { email: "bob@example.com" },
      ]);
    });
  });

  describe("calendar_get_event", () => {
    it("returns event details with attendees", async () => {
      const mockEvent = {
        id: "ev5",
        summary: "Board meeting",
        status: "confirmed",
        start: { dateTime: "2024-03-15T14:00:00-07:00" },
        end: { dateTime: "2024-03-15T16:00:00-07:00" },
        location: "HQ",
        description: "Quarterly review",
        creator: { email: "boss@example.com" },
        attendees: [
          { email: "alice@example.com", responseStatus: "accepted" },
          { email: "bob@example.com", responseStatus: "needsAction" },
        ],
        htmlLink: "https://calendar.google.com/event/ev5",
      };
      vi.stubGlobal("fetch", mockFetchResponse(mockEvent));

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_get_event");
      const result = await tool.execute("call9", { eventId: "ev5" });

      expect(result.content[0].text).toContain("Board meeting");
      expect(result.content[0].text).toContain("HQ");
      expect(result.content[0].text).toContain("Quarterly review");
      expect(result.content[0].text).toContain("alice@example.com (accepted)");
      expect(result.content[0].text).toContain("bob@example.com (needsAction)");
    });
  });

  describe("error handling", () => {
    it("throws when no auth configured", async () => {
      const tools = createCalendarTools(fakeApi({ pluginConfig: {} }));
      const tool = findTool(tools, "calendar_list_events");
      await expect(tool.execute("call10", {})).rejects.toThrow(/auth not configured/);
    });

    it("throws on 401 response", async () => {
      vi.stubGlobal("fetch", mockFetchResponse({}, false, 401));

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_list_events");
      await expect(tool.execute("call11", {})).rejects.toThrow(/Google Calendar API error \(401\)/);
    });

    it("throws on 404 response", async () => {
      vi.stubGlobal("fetch", mockFetchResponse({}, false, 404));

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_get_event");
      await expect(tool.execute("call12", { eventId: "nonexistent" })).rejects.toThrow(
        /Google Calendar API error \(404\)/,
      );
    });

    it("sends Authorization header with Bearer token", async () => {
      const mockData = { items: [] };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createCalendarTools(fakeApi());
      const tool = findTool(tools, "calendar_list_events");
      await tool.execute("call13", {});

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token-123");
    });

    it("uses calendarId from plugin config", async () => {
      const mockData = { items: [] };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createCalendarTools(
        fakeApi({
          pluginConfig: { accessToken: "tok", calendarId: "work@group.calendar.google.com" },
        }),
      );
      const tool = findTool(tools, "calendar_list_events");
      await tool.execute("call14", {});

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain(encodeURIComponent("work@group.calendar.google.com"));
    });
  });
});
